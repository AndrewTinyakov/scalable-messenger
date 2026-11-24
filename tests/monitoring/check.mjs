import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const prometheus = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const password = process.env.GRAFANA_ADMIN_PASSWORD ?? 'admin';
const expected = {
  api: 2,
  'command-processor': 2,
  'outbox-publisher': 2,
  ws: Number(process.env.MESSENGER_WS_REPLICAS ?? 2),
  rabbitmq: 3,
  'rabbitmq-queues': 3,
  redis: 6,
  postgres: 1,
  ingress: 2,
  containers: 1,
  prometheus: 1,
  alertmanager: 1,
};

assert.ok(Number.isSafeInteger(expected.ws) && expected.ws > 0, 'MESSENGER_WS_REPLICAS must be a positive integer');

async function getJson(url, options) {
  const response = await fetch(url, options);
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`);
  return response.json();
}

let targetError;
for (let attempt = 0; attempt < 45; attempt++) {
  try {
    const targets = (await getJson(`${prometheus}/api/v1/targets`)).data.activeTargets;
    targetError = undefined;
    for (const [job, count] of Object.entries(expected)) {
      const matches = targets.filter((target) => target.labels.job === job);
      assert.equal(matches.length, count, `${job}: expected ${count} targets, found ${matches.length}`);
      for (const target of matches) {
        assert.equal(target.health, 'up', `${job} ${target.labels.instance}: ${target.lastError || target.health}`);
      }
    }
    break;
  } catch (error) {
    targetError = error;
    await delay(1000);
  }
}
if (targetError) throw targetError;

for (const metric of [
  'messenger_ws_connections',
  'messenger_ws_pending_acks',
  'messenger_ws_pending_upgrades',
  'messenger_ws_oldest_pending_ack_seconds',
  'messenger_outbox_pending',
  'jvm_memory_used_bytes{job="command-processor"}',
  'rabbitmq_detailed_queue_messages_ready',
  'redis_up',
  'pg_up',
  'messenger_postgres_wal_syncs_total',
  'messenger_postgres_wal_sync_seconds_total',
  'messenger_postgres_activity_lock_waiting',
  'messenger_postgres_activity_oldest_lock_query_age_seconds',
  'messenger_postgres_statements_deallocations_total',
  'messenger_postgres_statements_reset_timestamp_seconds',
  'nginx_up',
  'container_cpu_usage_seconds_total{image!=""}',
  'container_memory_working_set_bytes{image!=""}',
  'messenger:minimum_scrape_targets',
  'messenger:unavailable_scrape_targets',
]) {
  const url = new URL('/api/v1/query', prometheus);
  url.searchParams.set('query', metric);
  const result = await getJson(url);
  assert.ok(result.data.result.length > 0, `${metric} has no series`);
}

for (const metric of ['pg_settings_track_io_timing', 'pg_settings_track_wal_io_timing', 'messenger_postgres_statements_preloaded', 'messenger_postgres_statements_installed', 'messenger_postgres_statements_planning_disabled', 'pg_scrape_collector_success{collector="stat_statements"}']) {
  const url = new URL('/api/v1/query', prometheus);
  url.searchParams.set('query', metric);
  const result = await getJson(url);
  assert.ok(result.data.result.length > 0 && result.data.result.every((series) => Number(series.value[1]) === 1), `${metric} must be enabled`);
}

async function query(expression) {
  const url = new URL('/api/v1/query', prometheus);
  url.searchParams.set('query', expression);
  return (await getJson(url)).data.result;
}

const kotlinSelector = 'job=~"api|command-processor|outbox-publisher"';
const kotlinTargets = await query(`up{${kotlinSelector}}`);
for (const metric of [
  `messenger_database_instrumentation_failures{${kotlinSelector}}`,
  `hikaricp_connections_acquire_seconds_bucket{${kotlinSelector},le="+Inf"}`,
  `hikaricp_connections_usage_seconds_bucket{${kotlinSelector},le="+Inf"}`,
]) {
  const series = await query(metric);
  for (const target of kotlinTargets) {
    assert.ok(series.some(({ metric: labels }) => labels.job === target.metric.job && labels.instance === target.metric.instance), `${metric}: missing on ${target.metric.job} ${target.metric.instance}`);
  }
  if (metric.startsWith('messenger_database_instrumentation_failures')) {
    assert.ok(series.every((sample) => Number(sample.value[1]) === 0), 'Database instrumentation has failed to record observations');
  }
}
const customQueryHealth = await query('pg_exporter_last_scrape_error{job="postgres"}');
assert.ok(customQueryHealth.length > 0 && customQueryHealth.every((sample) => Number(sample.value[1]) === 0), 'PostgreSQL custom query scrape failed or is missing');

const entryPointKinds = ['route', 'job', 'rpc', 'thread'];
const requestData = /[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-|\d{4,}/i;
for (const [name, outcomes] of [
  ['query', ['success', 'failure']],
  ['transaction', ['committed', 'rolled_back', 'failed', 'begin_failed']],
  ['transaction_phase', ['success', 'failure']],
]) {
  const series = await query(`{__name__=~"messenger_database_${name}_seconds_(count|sum|bucket)",${kotlinSelector}}`);
  const allowedLabels = new Set(['__name__', 'job', 'instance', 'entrypoint_kind', 'entrypoint', 'outcome', 'le', ...(name === 'transaction_phase' ? ['phase'] : [])]);
  for (const { metric: labels } of series) {
    assert.ok(entryPointKinds.includes(labels.entrypoint_kind), `${name}: unrecognized entry point kind ${labels.entrypoint_kind}`);
    assert.ok(labels.entrypoint && !requestData.test(labels.entrypoint), `${name}: entry point looks like request data: ${labels.entrypoint}`);
    assert.ok(outcomes.includes(labels.outcome), `${name}: unrecognized outcome ${labels.outcome}`);
    assert.ok(Object.keys(labels).every((label) => allowedLabels.has(label)), `${name}: unexpected metric label`);
    if (name === 'transaction_phase') assert.ok(['begin', 'active', 'commit', 'rollback'].includes(labels.phase), `Unrecognized transaction phase ${labels.phase}`);
  }
  for (const target of kotlinTargets.filter(({ metric }) => metric.job === 'outbox-publisher')) {
    assert.ok(series.some(({ metric, value }) => metric.__name__.endsWith('_count') && metric.job === target.metric.job && metric.instance === target.metric.instance && metric.entrypoint_kind === 'thread' && metric.entrypoint === 'outbox-publisher' && Number(value[1]) > 0), `${name}: publisher polling has no outbox-publisher observations on ${target.metric.instance}`);
  }
}
const digests = await query('pg_stat_statements_calls_total{job="postgres"}');
assert.ok(digests.length > 0 && digests.length <= 25, 'Statement collector must expose a nonempty subset of at most 25 entries');
for (const { metric: labels } of digests) {
  assert.ok(Object.keys(labels).every((label) => ['__name__', 'job', 'instance', 'user', 'datname', 'queryid'].includes(label)), 'Statement collector exposes an unexpected label');
  assert.match(labels.queryid, /^-?\d+$/, 'Statement collector query ID must be numeric');
}
assert.equal((await query('pg_stat_statements_query_id{job="postgres"}')).length, 0, 'Statement collector must not export query text mappings');

const dashboardNames = ['messenger-overview', 'messenger-websocket', 'messenger-backend', 'messenger-database', 'messenger-features'];
for (const name of dashboardNames) {
  const path = join(import.meta.dirname, '..', '..', 'deploy', 'grafana', 'dashboards', `${name}.json`);
  const dashboard = JSON.parse(await readFile(path, 'utf8'));
  const remote = await getJson(`${grafana}/api/dashboards/uid/${dashboard.uid}`, {
    headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` },
  });
  assert.equal(remote.dashboard.uid, dashboard.uid);
  assert.deepEqual(remote.dashboard.links, dashboard.links, `${name}: navigation links differ`);
  assert.deepEqual(remote.dashboard.panels.map((panel) => panel.fieldConfig?.defaults?.unit), dashboard.panels.map((panel) => panel.fieldConfig?.defaults?.unit), `${name}: provisioned units differ`);
  assert.deepEqual(remote.dashboard.panels.map((panel) => panel.title), dashboard.panels.map((panel) => panel.title), `${name}: provisioning has not loaded current panels`);
  const expressions = (panels) => panels.map((panel) => (panel.targets ?? []).map((target) => target.expr));
  assert.deepEqual(expressions(remote.dashboard.panels), expressions(dashboard.panels), `${name}: provisioned queries differ`);
  for (const panel of dashboard.panels) {
    const references = (panel.targets ?? []).map((target) => target.refId);
    assert.equal(new Set(references).size, references.length, `${name}: ${panel.title} has duplicate query references`);
    for (const target of panel.targets ?? []) {
      const expression = target.expr.replaceAll('$__rate_interval', '5m').replaceAll('$__range', '1h').replaceAll('$project', 'messenger.*').replaceAll('$service', 'api|command-processor|outbox-publisher').replaceAll('$entrypoint', '.*');
      const url = new URL('/api/v1/query', prometheus);
      url.searchParams.set('query', expression);
      const result = await getJson(url);
      assert.equal(result.status, 'success', `${name}: ${panel.title}`);
      if (panel.title.startsWith('Current container ')) {
        assert.ok(result.data.result.length > 0, `${name}: ${panel.title} has no live container observations`);
        const names = result.data.result.map((series) => series.metric.name);
        assert.equal(new Set(names).size, names.length, `${name}: ${panel.title} duplicates container names`);
      }
    }
  }
  if (dashboard.uid === 'messenger-overview') {
    const expression = dashboard.panels.find((panel) => panel.id === 12).targets[0].expr;
    assert.match(expression, /ALERTS\{[^}]*\}/);
    for (const state of ['none', 'pending', 'firing']) {
      const fixture = state === 'none' ? 'vector(1)<0' : `label_replace(label_replace(vector(1),"alertname","MonitoringRegression","",""),"alertstate","${state}","","")`;
      const url = new URL('/api/v1/query', prometheus);
      url.searchParams.set('query', expression.replaceAll(/ALERTS\{[^}]*\}/g, `(${fixture})`));
      const rows = (await getJson(url)).data.result;
      assert.equal(rows.length, 1, `Incident table must show one truthful row for ${state}`);
      assert.equal(rows[0].metric.alertname, state === 'none' ? 'No active or pending alerts' : 'MonitoringRegression');
    }
  }
}

const coverageUrl = new URL('/api/v1/query', prometheus);
coverageUrl.searchParams.set('query', 'messenger:unavailable_scrape_targets');
const coverage = (await getJson(coverageUrl)).data.result;
assert.deepEqual(coverage.map((series) => series.metric.job).sort(), Object.keys(expected).sort(), 'Scrape coverage must retain every required service');
assert.ok(coverage.every((series) => Number(series.value[1]) === 0), 'Required scrape targets are missing or down');

console.log(`Monitoring healthy: ${Object.values(expected).reduce((a, b) => a + b, 0)} targets and ${dashboardNames.length} dashboards`);
