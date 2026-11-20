import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { privateOutputPath, readPrivate } from '../features-load/http.mjs';
import { mergeReports } from './merge.mjs';
import { buildPlan } from './plan.mjs';
import { setup } from './setup.mjs';
import { check, Fault, Http, Measurements } from './transport.mjs';

const optionsSpec = {
  remote: { type: 'boolean' },
  ...Object.fromEntries(
  ['profile', 'seed', 'output', 'plan', 'manifest', 'compose-project', 'report', 'api', 'ws', 'origin', 'auth-rate', 'ticket-rate',
    'workers', 'shard', 'start-at']
    .map(name => [name, { type: 'string' }])),
};

async function json(path, limit) {
  const info = await stat(path);
  check(info.isFile() && info.size <= limit, 'inputSize');
  const data = await readFile(path);
  check(data.byteLength <= limit, 'inputSize');
  return JSON.parse(data);
}

function endpoint(raw, protocols, remote) {
  const url = new URL(raw);
  check(protocols.includes(url.protocol) && (remote || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) &&
    !url.username && !url.password && !url.search && !url.hash, 'localhostEndpointRequired');
  return url.href.replace(/\/$/, '');
}

function summarize(plan, report) {
  process.stdout.write(`${plan.profile.name} ${report.passed ? 'passed' : 'failed'}, ${report.correctness.saved} saved, ${report.correctness.missing} missing, ${report.correctness.pending} pending, ${report.metrics.latencies.schedulingLag?.maxMs.toFixed(1)} ms max scheduling lag\n`);
  for (const stage of report.metrics.stages ?? []) {
    const p99 = name => stage.latencies[name]?.p99UpperMs.toFixed(0) ?? '-';
    const failures = Object.values(stage.failures).reduce((a, b) => a + b, 0);
    const errors = Object.entries(stage.httpStatuses).filter(([code]) => code >= 500 || code === '429').reduce((a, [, n]) => a + n, 0);
    process.stdout.write(`  ${stage.users} users from ${stage.atMs / 1000}s: p99 own ack ${p99('send.ownAck')} ms, delivery ${p99('send.recipientLive')} ms, chat open ${p99('chatOpen.firstPageReady')} ms, lag ${p99('schedulingLag')} ms, ${failures} failures, ${errors} HTTP 429/5xx\n`);
  }
}

async function coordinate(values, workers) {
  const startAt = Date.now() + 10_000;
  const script = fileURLToPath(import.meta.url);
  const parts = Array.from({ length: workers }, (_, index) => `${values.report}.shard-${index}.json`);
  const share = (raw, fallback) => String(Math.max(1, Math.ceil(Number(raw ?? fallback) / workers)));
  const pass = ['plan', 'manifest', 'api', 'ws', 'origin', 'compose-project'].flatMap(name =>
    values[name] === undefined ? [] : ['--' + name, values[name]]).concat(values.remote ? ['--remote'] : []);
  const codes = await Promise.all(parts.map((report, index) => new Promise(resolve => {
    const child = spawn(process.execPath, [script, 'run', ...pass, '--report', report, '--shard', `${index}/${workers}`,
      '--start-at', String(startAt), '--auth-rate', share(values['auth-rate'], 1), '--ticket-rate', share(values['ticket-rate'], 4)],
    { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', code => resolve(code));
  })));
  const reports = await Promise.all(parts.map(path => json(path, 512 * 2 ** 20).catch(() => null)));
  check(reports.every(Boolean), `shardFailed:${codes.join(',')}`);
  await Promise.all(parts.map(path => rm(path, { force: true })));
  return mergeReports(reports);
}

async function main() {
  const { positionals: [command, ...rest], values } = parseArgs({ options: optionsSpec, allowPositionals: true });
  check(['plan', 'setup', 'run', 'merge'].includes(command) && (command === 'merge' || rest.length === 0), 'command');
  if (command === 'merge') {
    check(values.report && rest.length > 0, 'reportAndShards');
    const report = mergeReports(await Promise.all(rest.map(path => json(path, 512 * 2 ** 20))));
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`merged ${rest.length} shards into ${values.report}: ${report.passed ? 'passed' : 'failed'}\n`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (command === 'plan') {
    check(values.profile && values.seed !== undefined, 'profileAndSeed');
    const plan = buildPlan(await json(values.profile, 16384), Number(values.seed));
    const encoded = JSON.stringify(plan) + '\n';
    if (values.output) await writeFile(values.output, encoded);
    else process.stdout.write(encoded);
    return;
  }
  check(values.plan && values.manifest, 'planAndManifest');
  const input = await json(values.plan, 512 * 2 ** 20);
  const plan = buildPlan(input.profile, input.seed);
  check(JSON.stringify(input) === JSON.stringify(plan), 'planMismatch');
  const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const workers = Number(values.workers ?? 1);
  check(Number.isInteger(workers) && workers >= 1 && workers <= 64 && !(workers > 1 && values.shard), 'workers');
  if (command === 'run' && workers > 1) {
    check(values.report, 'reportRequired');
    const report = await coordinate(values, workers);
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
    summarize(plan, report);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  const [shardIndex, shardCount] = (values.shard ?? '0/1').split('/').map(Number);
  check(Number.isInteger(shardIndex) && Number.isInteger(shardCount) && shardCount >= 1 && shardCount <= 64 &&
    shardIndex >= 0 && shardIndex < shardCount, 'shard');
  const startAt = values['start-at'] === undefined ? undefined : Number(values['start-at']);
  check(startAt === undefined || Number.isSafeInteger(startAt), 'startAt');
  const options = {
    api: endpoint(values.api ?? 'http://localhost:8081/api', ['http:', 'https:'], values.remote),
    ws: endpoint(values.ws ?? 'ws://localhost:8082/ws', ['ws:', 'wss:'], values.remote),
    origin: endpoint(values.origin ?? 'http://localhost:8080', ['http:', 'https:'], values.remote),
    manifest: privateOutputPath(values.manifest),
    composeProject: values['compose-project'] ?? 'messenger',
    authRate: Number(values['auth-rate'] ?? 1),
    ticketRate: Number(values['ticket-rate'] ?? 4),
    // Driver queue limits are sized for 1,000 users and grow with the population.
    capacity: Math.ceil(plan.population.length / shardCount / 1000),
  };
  check(options.authRate >= 1 && options.authRate <= 200 && options.ticketRate >= 1 && options.ticketRate <= 500, 'rateBounds');
  const metrics = new Measurements();
  const http = new Http(options, metrics);
  const halt = () => http.controller.abort(new Fault('interrupted'));
  process.on('SIGINT', halt);
  process.on('SIGTERM', halt);
  try {
    if (command === 'setup') {
      check(/^[a-z0-9][a-z0-9_-]*$/.test(options.composeProject), 'composeProject');
      await setup(plan, options, http, fingerprint);
    } else {
      check(values.report, 'reportRequired');
      const manifest = await readPrivate(options.manifest);
      check(manifest.format === 'realistic-load-session-v1' && manifest.fingerprint === fingerprint, 'manifestMismatch');
      const { run } = await import('./run.mjs');
      const report = await run(plan, manifest, http, metrics, { shard: { index: shardIndex, count: shardCount }, startAt });
      await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
      summarize(plan, report);
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) {
    metrics.failure(command, error);
    process.stderr.write(JSON.stringify(metrics.failures) + '\n');
    process.exitCode = 1;
  } finally {
    http.controller.abort();
    await Promise.all([http.auth.join(), http.tickets.join()]);
    process.off('SIGINT', halt);
    process.off('SIGTERM', halt);
  }
}

main().catch(error => {
  process.stderr.write(`realistic-load: ${error instanceof Fault ? error.code : 'invalid input or local I/O failure'}\n`);
  process.exitCode = 1;
});
