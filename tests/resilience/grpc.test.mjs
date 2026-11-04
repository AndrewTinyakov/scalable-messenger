import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { composeOptions } from '../support/runtime.mjs';

test('gRPC stays on its internal network and rejects connections through the HTTP network', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 20000,
}, () => {
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
  const apiId = docker('compose', ...composeOptions, 'ps', '--status', 'running', '-q', 'api-1');
  assert.ok(apiId, 'API instance must be running');
  const networks = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', apiId));
  const grpcNetwork = Object.keys(networks).find((name) => name.endsWith('_grpc'));
  assert.ok(grpcNetwork, 'API must join its dedicated gRPC network');
  assert.equal(docker('network', 'inspect', '--format', '{{.Internal}}', grpcNetwork), 'true');
  for (const service of ['api-1', 'api-2']) {
    const command = ['compose', ...composeOptions, 'exec', '-T', 'api-proxy', 'nc', '-w', '2', service];
    docker(...command, '8080', '-e', '/bin/true');
    assert.throws(() => docker(...command, '9090', '-e', '/bin/true'), (error) => error.status === 1,
      `${service} exposed gRPC through its HTTP network interface`);
  }
});
