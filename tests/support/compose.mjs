import { execFileSync } from 'node:child_process';
import { composeOptions, redisNodes } from './runtime.mjs';

export function compose(...args) {
  execFileSync('docker', ['compose', ...composeOptions, ...args], { stdio: 'pipe' });
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
