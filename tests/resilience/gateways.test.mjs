import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { composeOptions } from '../support/runtime.mjs';
import { connect } from '../support/socket-client.mjs';
import { compose } from '../support/compose.mjs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

test('replicated gateways distribute sockets and accept reconnects after one drains', {
	skip: process.env.MESSENGER_RESILIENCE !== '1' || Number(process.env.MESSENGER_WS_REPLICAS ?? 2) < 2,
	timeout: 90000,
}, async (t) => {
	const nodes = execFileSync('docker', ['compose', ...composeOptions, 'ps', '--status', 'running', '-q', 'ws'])
		.toString().trim().split('\n').filter(Boolean);
	assert.equal(nodes.length, Number(process.env.MESSENGER_WS_REPLICAS ?? 2));
	const account = await api('/auth/register', {
		method: 'POST', body: { username: `ws_replicas_${randomBytes(5).toString('hex')}`, password: 'long-demo-password' },
	});
	const clients = [];
	t.after(() => { for (const client of clients) client.socket.close(); });
	for (let i = 0; i < 6; i++) clients.push(await connect(account.cookie));
	const connectedNodes = nodes.map((node) => {
		const metrics = execFileSync('docker', ['exec', node, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8081/metrics']).toString();
		const connections = Number(metrics.match(/^messenger_ws_connections ([\d.e+-]+)$/m)?.[1] ?? 0);
		return { node, connections };
	}).filter(({ connections }) => connections > 0);
	assert.ok(connectedNodes.length > 1, 'Docker DNS upstream did not distribute connections across replicas');
	const stopped = connectedNodes[0].node;
	t.after(() => execFileSync('docker', ['start', stopped], { stdio: 'pipe' }));
	execFileSync('docker', ['stop', '--time', '20', stopped], { stdio: 'pipe', timeout: 25000 });
	const deadline = Date.now() + 10000;
	while (!clients.some((client) => client.socket.readyState === WebSocket.CLOSED) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(clients.some((client) => client.socket.readyState === WebSocket.CLOSED), 'draining gateway did not close its connections');
	for (const client of clients.filter((client) => client.socket.readyState === WebSocket.CLOSED)) {
		let replacement;
		for (let attempt = 0; attempt < 5 && !replacement; attempt++) {
			try { replacement = await connect(account.cookie); }
			catch { await new Promise((resolve) => setTimeout(resolve, 1200)); }
		}
		assert.ok(replacement, 'surviving replica did not accept a reconnect');
		clients.push(replacement);
	}
});
