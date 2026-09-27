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
  ws: 2,
  rabbitmq: 3,
  'rabbitmq-queues': 3,
  redis: 6,
  postgres: 1,
  ingress: 3,
};

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
  'messenger_outbox_pending',
  'jvm_memory_used_bytes{job="command-processor"}',
  'rabbitmq_detailed_queue_messages_ready',
  'redis_up',
  'pg_up',
  'nginx_up',
]) {
  const url = new URL('/api/v1/query', prometheus);
  url.searchParams.set('query', metric);
  const result = await getJson(url);
  assert.ok(result.data.result.length > 0, `${metric} has no series`);
}

const dashboardNames = ['messenger-overview', 'messenger-websocket', 'messenger-backend'];
for (const name of dashboardNames) {
  const path = join(import.meta.dirname, '..', 'deploy', 'grafana', 'dashboards', `${name}.json`);
  const dashboard = JSON.parse(await readFile(path, 'utf8'));
  const remote = await getJson(`${grafana}/api/dashboards/uid/${dashboard.uid}`, {
    headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` },
  });
  assert.equal(remote.dashboard.uid, dashboard.uid);
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      const expression = target.expr.replaceAll('$__rate_interval', '5m');
      const url = new URL('/api/v1/query', prometheus);
      url.searchParams.set('query', expression);
      const result = await getJson(url);
      assert.equal(result.status, 'success', `${name}: ${panel.title}`);
    }
  }
}

console.log(`Monitoring healthy: ${Object.values(expected).reduce((a, b) => a + b, 0)} targets and ${dashboardNames.length} dashboards`);
