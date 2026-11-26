// Presence-only load benchmark. See README.md.
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { buildPlan, DEFAULTS } from './plan.mjs';
import { Bench } from './run.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { detectCookieName, fetchTickets, readManifest, refreshTickets, seedDatabase, ticketClient, writeManifest } from './seed.mjs';

const { positionals: [command], values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' }, api: { type: 'string' }, ws: { type: 'string' }, origin: { type: 'string' },
    manifest: { type: 'string' }, report: { type: 'string' }, prometheus: { type: 'string' },
    protocol: { type: 'string' }, scenario: { type: 'string' }, 'fault-container': { type: 'string' },
    users: { type: 'string' }, degree: { type: 'string' }, seed: { type: 'string' },
    'ticket-rate': { type: 'string', default: '150' }, 'connect-rate': { type: 'string', default: '100' },
  },
});

const required = (...names) => {
  for (const name of names) if (!values[name]) throw new Error(`--${name} is required`);
};
const number = (name, fallback) => values[name] === undefined ? fallback : Number(values[name]);

if (command === 'seed') {
  required('project', 'api', 'origin', 'manifest');
  const params = { seed: number('seed', DEFAULTS.seed), users: number('users', DEFAULTS.users), degree: number('degree', DEFAULTS.degree) };
  const plan = buildPlan(params);
  console.error(`Seeding ${plan.users.length} users, ${plan.directs.length} direct chats, ${plan.groups.length} groups into ${values.project}`);
  const tokens = await seedDatabase(plan, values.project);
  const manifest = { project: values.project, api: values.api, origin: values.origin, params, tokens };
  const http = ticketClient({ api: values.api, origin: values.origin, ticketRate: number('ticket-rate') });
  manifest.cookieName = await detectCookieName(http, manifest, plan);
  await writeManifest(values.manifest, manifest);
  console.error(`Seeded; session cookie ${manifest.cookieName}; manifest ${values.manifest}`);
} else if (command === 'run') {
  required('manifest', 'ws', 'protocol', 'scenario', 'report');
  if (!['legacy', 'current'].includes(values.protocol)) throw new Error('--protocol must be legacy or current');
  const scenario = SCENARIOS[values.scenario];
  if (!scenario) throw new Error(`--scenario must be one of ${Object.keys(SCENARIOS).join(', ')}`);
  const manifest = await readManifest(values.manifest);
  const plan = buildPlan(manifest.params);
  const http = ticketClient({ api: manifest.api, origin: manifest.origin, ticketRate: number('ticket-rate') });
  // Tickets for everyone the scenario may connect, fetched before any timed window.
  console.error(`Fetching ${scenario.users} tickets`);
  const tickets = await fetchTickets(http, manifest, plan, plan.order.slice(0, scenario.users));
  const stopRefresh = refreshTickets(http, manifest, plan, tickets, console.error);
  const bench = new Bench({
    plan, protocol: values.protocol, url: values.ws, origin: manifest.origin, prometheus: values.prometheus,
    ticket: user => tickets.get(user).token, connectRate: number('connect-rate'),
  });
  const startedAt = Date.now();
  try {
    const windows = await scenario.run(bench, { container: values['fault-container'] });
    await bench.drain();
    const { failures } = bench;
    const report = {
      protocol: values.protocol, scenario: values.scenario, project: manifest.project, params: manifest.params,
      startedAt, endedAt: Date.now(), connectRate: bench.connectRate, failures, windows,
    };
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
    console.error(`Report: ${values.report}`);
    if (failures.length) {
      console.error(`Failed checks:\n- ${failures.join('\n- ')}`);
      process.exitCode = 1;
    }
  } finally {
    stopRefresh();
    bench.close();
    http.controller.abort();
  }
} else {
  console.error('Usage: node tests/presence-load/main.mjs seed|run [options] (see README.md)');
  process.exitCode = 2;
}
