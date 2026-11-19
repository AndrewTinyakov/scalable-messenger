import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { privateOutputPath, readPrivate } from '../features-load/http.mjs';
import { buildPlan } from './plan.mjs';
import { setup } from './setup.mjs';
import { check, Fault, Http, Measurements } from './transport.mjs';

const optionsSpec = Object.fromEntries(
  ['profile', 'seed', 'output', 'plan', 'manifest', 'compose-project', 'report', 'api', 'ws', 'origin', 'auth-rate', 'ticket-rate']
    .map(name => [name, { type: 'string' }]),
);

async function json(path, limit) {
  const info = await stat(path);
  check(info.isFile() && info.size <= limit, 'inputSize');
  const data = await readFile(path);
  check(data.byteLength <= limit, 'inputSize');
  return JSON.parse(data);
}

function endpoint(raw, protocols) {
  const url = new URL(raw);
  check(protocols.includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash, 'localhostEndpointRequired');
  return url.href.replace(/\/$/, '');
}

async function main() {
  const { positionals: [command, ...rest], values } = parseArgs({ options: optionsSpec, allowPositionals: true });
  check(rest.length === 0 && ['plan', 'setup', 'run'].includes(command), 'command');
  if (command === 'plan') {
    check(values.profile && values.seed !== undefined, 'profileAndSeed');
    const plan = buildPlan(await json(values.profile, 16384), Number(values.seed));
    const encoded = JSON.stringify(plan) + '\n';
    if (values.output) await writeFile(values.output, encoded);
    else process.stdout.write(encoded);
    return;
  }
  check(values.plan && values.manifest, 'planAndManifest');
  const input = await json(values.plan, 32 * 2 ** 20);
  const plan = buildPlan(input.profile, input.seed);
  check(JSON.stringify(input) === JSON.stringify(plan), 'planMismatch');
  const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const options = {
    api: endpoint(values.api ?? 'http://localhost:8081/api', ['http:', 'https:']),
    ws: endpoint(values.ws ?? 'ws://localhost:8082/ws', ['ws:', 'wss:']),
    origin: endpoint(values.origin ?? 'http://localhost:8080', ['http:', 'https:']),
    manifest: privateOutputPath(values.manifest),
    composeProject: values['compose-project'] ?? 'messenger',
    authRate: Number(values['auth-rate'] ?? 1),
    ticketRate: Number(values['ticket-rate'] ?? 4),
  };
  check(options.authRate >= 1 && options.authRate <= 100 && options.ticketRate >= 1 && options.ticketRate <= 25, 'rateBounds');
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
      const report = await run(plan, manifest, http, metrics);
      await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`${plan.profile.name} ${report.passed ? 'passed' : 'failed'}, ${report.correctness.saved} saved, ${report.correctness.missing} missing, ${report.correctness.pending} pending, ${report.metrics.latencies.schedulingLag?.maxMs.toFixed(1)} ms max scheduling lag\n`);
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
