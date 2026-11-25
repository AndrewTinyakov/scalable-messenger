#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Metrics } from './metrics.mjs';
import { Http, writePrivate, privateOutputPath } from './http.mjs';
import { Socket } from './socket.mjs';
import { topology, loadSource } from './topology.mjs';
import { Driver } from './driver.mjs';
import { bounded } from './plan.mjs';
import { ticketAdmission } from './tickets.mjs';
import { assess } from './assessment.mjs';

const { values } = parseArgs({ options: {
  phase: { type: 'string', default: 'measure' }, manifest: { type: 'string' }, output: { type: 'string' }, report: { type: 'string' },
  seed: { type: 'string', default: '1103' }, users: { type: 'string', default: '100' }, duration: { type: 'string', default: '120' },
  'send-rate': { type: 'string', default: '2' }, scenario: { type: 'string', default: 'mixed' }, 'reconnect-fraction': { type: 'string', default: '0.1' }, drain: { type: 'string', default: '20' },
  api: { type: 'string', default: process.env.MESSENGER_API_BASE_URL ?? 'http://localhost:8081/api' },
  ws: { type: 'string', default: process.env.MESSENGER_WS_URL ?? 'ws://localhost:8082/ws' },
  origin: { type: 'string', default: process.env.MESSENGER_CLIENT_ORIGIN ?? 'https://messenger.localhost' },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  console.log('Node24: main.mjs --phase setup|measure --manifest /private/input.json --output /private/topology.json --report /private/report.json --users 100 --scenario mixed|direct|small|large --seed 1103 --duration 120 --send-rate 2 --reconnect-fraction 0.1 --drain 20 [--api URL --ws URL --origin URL]');
  process.exit(0);
}
const options = { ...values, seed: Number(values.seed), users: Number(values.users), duration: Number(values.duration), sendRate: Number(values['send-rate']), reconnectFraction: Number(values['reconnect-fraction']), drain: Number(values.drain) };
if (!options.manifest || !['setup', 'measure'].includes(options.phase) || !['mixed', 'direct', 'small', 'large'].includes(options.scenario)) throw new Error('A manifest and valid phase/scenario are required');
for (const [key, minimum, maximum, integer] of [['seed', 0, 4294967295, true], ['users', 4, 1000, true], ['duration', 5, 3600, false], ['sendRate', .01, 100, false], ['reconnectFraction', 0, 1, false], ['drain', 1, 60, false]]) {
  if (!Number.isFinite(options[key]) || options[key] < minimum || options[key] > maximum || integer && !Number.isInteger(options[key])) throw new Error(`Invalid ${key}`);
}
if (options.sendRate * options.duration > 20000) throw new Error('At most 20000 offered sends per run');
options.maxSends = Math.floor(options.sendRate * options.duration);
if (options.phase === 'setup' && !options.output) throw new Error('Setup requires --output outside the repository');
if (options.output && resolve(options.output) === resolve(options.manifest)) throw new Error('Do not overwrite the input manifest');
if (options.phase === 'measure' && !options.report) throw new Error('Measurement requires --report outside the repository');
if (options.output) privateOutputPath(options.output);
if (options.report) privateOutputPath(options.report);
if (options.report && resolve(options.report) === resolve(options.manifest)) throw new Error('Do not overwrite the input manifest');
const metrics = new Metrics();
const http = new Http(options, metrics);
const driver = new Driver(options, metrics, http);
const sockets = [];
let fatal = null;
const startedAt = new Date().toISOString();
process.once('SIGINT', () => {
  fatal = new Error('Interrupted');
  driver.stopping = true;
  http.controller.abort(fatal);
  void Promise.allSettled(sockets.map(socket => socket.close()));
});
try {
  const source = await loadSource(options);
  source.sessions.forEach((session, index) => sockets.push(new Socket(index, session, http, options, metrics, (socket, event, at) => driver.receive(socket, event, at))));
  console.error(`Opening ${sockets.length} existing sessions during setup`);
  await bounded(sockets, 8, socket => socket.connect());
  const chats = await topology(options, http, sockets, source);
  if (options.phase === 'setup') {
    console.log(JSON.stringify({ phase: 'setup', chats: chats.length, users: sockets.length, topology: options.output, ticketAdmission: ticketAdmission.report() }));
  } else {
    console.error(`Warming ${chats.length} owned chats before measurement`);
    await driver.prepare(chats, sockets);
    console.error(`Measuring ${options.duration}s at ${options.sendRate} offered messages/s`);
    await driver.run();
  }
} catch (error) {
  fatal = error;
  metrics.failure('driver.fatal', error);
} finally {
  await Promise.allSettled([...driver.tasks]);
  await ticketAdmission.join();
  await bounded(sockets, 16, socket => socket.close());
}
if (options.phase === 'measure' || fatal) {
  const counts = metrics.counts;
  const assessment = assess(counts);
  const traffic = { scheduling: 'bounded-deferred-v1', sendBacklogLimit: 64, activeSenderFractionPerChat: .1, foregroundDwellMs: 700, readMinimumIntervalMs: 1000, lookupIntervalMs: 2000, mutationIntervalMs: 5000, replyEvery: 5, maxPresenceTargets: 100, activeSenderUsers: new Set([...driver.records.values()].map(record => record.sender)).size };
  const report = { traffic, assessment, ticketAdmission: ticketAdmission.report(), format: 'messenger-features-report-v1', startedAt, endedAt: new Date().toISOString(), runtime: process.version, parameters: { seed: options.seed, users: options.users, duration: options.duration, sendRate: options.sendRate, scenario: options.scenario, reconnectFraction: options.reconnectFraction, drain: options.drain }, phases: { setupExcluded: true, measurementMs: driver.measurementMs ?? 0, drainIncludedInRequestHistograms: true }, topology: driver.chats.map(chat => ({ id: chat.id, cohort: chat.cohort, members: chat.members.length, baseline: chat.baseline })), rates: { offeredMessagesPerSecond: options.sendRate, dispatchedMessagesPerSecond: (counts['send.dispatched'] ?? 0) / ((driver.measurementMs ?? 1) / 1000), savedMessagesPerSecond: (counts['send.saved'] ?? 0) / ((driver.measurementMs ?? 1) / 1000) }, retained: driver.retained(), metrics: metrics.report(), passed: assessment.passed, fatal: fatal?.message ?? null };
  if (options.report) await writePrivate(options.report, report);
  console.log(JSON.stringify(report, null, 2));
  if (!assessment.passed) process.exitCode = 1;
}
