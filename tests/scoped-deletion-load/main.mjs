import assert from 'node:assert/strict';
import { cpus, totalmem, platform, arch } from 'node:os';
import { parseArgs } from 'node:util';
import { readPrivate, writePrivate, privateOutputPath } from '../features-load/http.mjs';
import { Runtime } from './runtime.mjs';
import { Fixtures } from './fixtures.mjs';
import { functional, messageBatches, mixed } from './checks.mjs';

const { values } = parseArgs({ options: {
  phase: { type: 'string', default: 'run' }, state: { type: 'string' }, report: { type: 'string' },
  api: { type: 'string', default: 'http://127.0.0.1:18081/api' }, ws: { type: 'string', default: 'ws://127.0.0.1:18082/ws' }, origin: { type: 'string', default: 'http://127.0.0.1:18080' },
  postgres: { type: 'string', default: 'messenger-browser-postgres-1' }, project: { type: 'string', default: 'messenger-browser' },
  sizes: { type: 'string', default: '10000,100000,1000000' }, repeats: { type: 'string', default: '20' }, timeout: { type: 'string', default: '600' },
  'skip-functional': { type: 'boolean', default: false },
} });
assert.ok(['setup', 'run'].includes(values.phase), 'phase must be setup or run');
assert.ok(values.state, '--state is required');
privateOutputPath(values.state);
const sizes = values.sizes.split(',').map(Number);
assert.ok(sizes.length >= 1 && sizes.length <= 3 && new Set(sizes).size === sizes.length && sizes.every(size => [10000, 100000, 1000000].includes(size)));
const options = { ...values, repeats: Number(values.repeats), timeout: Number(values.timeout), tag: Date.now().toString(36) };
assert.ok(Number.isInteger(options.repeats) && options.repeats >= 1 && options.repeats <= 100);
assert.ok(Number.isInteger(options.timeout) && options.timeout >= 10 && options.timeout <= 900);
if (values.phase === 'run') { assert.ok(values.report, '--report is required'); privateOutputPath(values.report); }

let runtime;
const report = { format: 'messenger-scoped-deletion-results-v1', startedAt: new Date().toISOString(), passed: false, settings: { api: options.api, ws: options.ws, origin: options.origin, sizes, repeats: options.repeats, timeoutSeconds: options.timeout, spanBudget: 16, fixtureBodyBytes: 128, sqlFixtureProvisioning: true, writeThroughputBenchmark: false }, host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version }, limitations: ['Public HTTP/WebSocket path, not browser UI/focus behavior.', 'Seeded historical rows omit send request and outbox histories. Public sends separately test those paths.', 'Warm cache timings are descriptive. Cache flush and a cold-cache comparison are not performed.', 'Purge completion includes polling granularity and post-acceptance public checks.', 'SQL deletion does not establish erasure from WAL, backups, Rabbit commands or already-delivered packets.'] };
try {
  if (values.phase === 'setup') {
    runtime = new Runtime(options);
    const accounts = await runtime.accounts();
    await writePrivate(values.state, { format: 'messenger-scoped-deletion-fixture-v1', tag: options.tag, ...accounts, fixtures: [] });
    process.stdout.write('Created three disposable accounts and a distinct second-device session. Private state saved.\n');
  } else {
    const state = await readPrivate(values.state);
    assert.equal(state.format, 'messenger-scoped-deletion-fixture-v1');
    assert.match(state.tag, /^[a-z0-9]+$/);
    options.tag = state.tag;
    runtime = new Runtime(options);
    const fixtures = new Fixtures(options);
    await fixtures.verify();
    report.before = await fixtures.resources();
    await runtime.connect(state);
    if (!values['skip-functional']) {
      report.functional = await functional(runtime);
      process.stdout.write('Public deletion behavior checks passed.\n');
    }
    const checkpoint = async fixture => {
      assert.ok(state.fixtures.length < 100, 'Fixture manifest cap reached');
      state.fixtures.push(fixture);
      await writePrivate(values.state, state);
    };
    report.messageBatches = await messageBatches(runtime, fixtures, checkpoint);
    const measured = await mixed(runtime, fixtures, sizes, checkpoint);
    Object.assign(report, measured);
    report.after = await fixtures.resources();
    const latencies = [...runtime.latencies].sort((a, b) => a - b);
    report.liveSavedLatency = { count: latencies.length, p50Ms: latencies[Math.ceil(latencies.length * .5) - 1], p95Ms: latencies[Math.ceil(latencies.length * .95) - 1], p99Ms: latencies[Math.ceil(latencies.length * .99) - 1], maxMs: latencies.at(-1) };
    assert.equal(runtime.metrics.errors.length, 0, 'Runtime transport or request errors recorded');
    report.passed = true;
    process.stdout.write(`Verified ${sizes.join('/')} row histories, scoped visibility, sparse recovery and completed purge.\n`);
  }
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  process.stderr.write(`Scoped deletion check failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (runtime) {
    await runtime.close();
    report.metrics = runtime.metrics.report();
    report.lastEvents = runtime.events;
    report.retained = { requests: runtime.seen.size, eventMetadata: runtime.events.length, rssBytes: process.memoryUsage().rss, heapBytes: process.memoryUsage().heapUsed };
  }
  report.finishedAt = new Date().toISOString();
  if (values.report) await writePrivate(values.report, report);
}
