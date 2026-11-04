import { execFileSync } from 'node:child_process';
import { composeOptions, redisNodes } from './runtime.mjs';

export function compose(...args) {
  execFileSync('docker', ['compose', ...composeOptions, ...args], { stdio: 'pipe' });
}

export async function startWorkers(...services) {
  compose('start', ...services);
  const ids = execFileSync('docker', ['compose', ...composeOptions, 'ps', '--all', '-q', ...services])
    .toString().trim().split('\n').filter(Boolean);
  if (!ids.length) throw new Error('No worker containers found');
  const names = JSON.parse(execFileSync('docker', ['inspect', ...ids]).toString())
    .map(container => container.Name.replace(/^\//, ''));
  const gateway = execFileSync('docker', ['compose', ...composeOptions, 'ps', '--status', 'running', '-q', 'ws'])
    .toString().trim().split('\n').filter(Boolean)[0];
  if (!gateway) throw new Error('No gateway available for worker readiness checks');
  const pending = new Set(names);
  const deadline = Date.now() + 60000;
  while (pending.size) {
    for (const name of pending) {
      try {
        const health = execFileSync('docker', ['exec', gateway, 'wget', '-q', '-T', '2', '-O', '-',
          `http://${name}:8082/actuator/health`], { stdio: 'pipe', timeout: 5000 });
        if (JSON.parse(health.toString()).status === 'UP') pending.delete(name);
      } catch {}
    }
    if (!pending.size) return;
    if (Date.now() >= deadline) throw new Error(`Workers did not become ready: ${[...pending].join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function waitForRedisCluster() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const healthy = redisNodes.every((node) => execFileSync('docker', [
        'compose', ...composeOptions, 'exec', '-T', node, 'redis-cli', 'cluster', 'info',
      ], { stdio: 'pipe' }).toString().includes('cluster_state:ok'));
      const nodes = execFileSync('docker', [
        'compose', ...composeOptions, 'exec', '-T', 'redis-1', 'redis-cli', 'cluster', 'nodes',
      ], { stdio: 'pipe' }).toString().trim().split('\n');
      if (healthy && nodes.length === redisNodes.length && nodes.every((node) => node.includes(' connected'))) return;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Redis Cluster did not recover');
}

export function sendQueue(senderId, recipientId) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from([senderId, recipientId].sort().join(':'))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return `messenger.send.${hash % 4}`;
}

export function rabbitQueues() {
  const output = execFileSync('docker', ['compose', ...composeOptions, 'exec', '-T',
    'rabbitmq-1', 'rabbitmqctl', 'list_queues', 'name', 'leader', 'members', '--formatter', 'json']);
  return JSON.parse(output.toString());
}
