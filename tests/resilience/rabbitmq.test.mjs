import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { ulid } from '../support/fixtures.mjs';
import { connect } from '../support/socket-client.mjs';
import { compose, startWorkers, sendQueue, rabbitQueues } from '../support/compose.mjs';
import { randomBytes } from 'node:crypto';

test('a send survives its queue leader failing and a publisher reconnect', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 120000,
}, async (t) => {
  const queues = rabbitQueues();
  assert.equal(queues.length, 5);
  for (const queue of queues) assert.equal(queue.members.length, 3);
  const targetQueue = queues.find((queue) => queue.name === 'messenger.send.0');
  assert.ok(targetQueue);
  const failedNode = targetQueue.leader.replace('rabbit@', '');
  const survivingNode = ['rabbitmq-1', 'rabbitmq-2', 'rabbitmq-3'].find((node) => node !== failedNode);

  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `fail_sender_${suffix}`, password: 'long-demo-password' } });
  let recipient;
  for (let i = 0; i < 20; i++) {
    const candidate = await api('/auth/register', { method: 'POST', body: { username: `fail_target_${i}_${suffix}`, password: 'long-demo-password' } });
    if (sendQueue(sender.user.id, candidate.user.id) === targetQueue.name) {
      recipient = candidate;
      break;
    }
  }
  assert.ok(recipient, 'could not find a direct send routed to the selected queue');
  const senderSocket = await connect(sender.cookie);
  const recipientSocket = await connect(recipient.cookie);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  compose('stop', 'messenger-command-processor');
  t.after(() => startWorkers('messenger-command-processor'));
  const pendingRequestId = ulid();
  senderSocket.send({ type: 'send', recipientId: recipient.user.id, requestId: pendingRequestId, body: 'Confirmed before queue leader failure' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === pendingRequestId);
  assert.equal((await api(`/sends/${pendingRequestId}`, { cookie: sender.cookie })).status, 'UNKNOWN');

  compose('stop', failedNode);
  t.after(() => {
    compose('start', failedNode);
    compose('exec', '-T', survivingNode, 'rabbitmqctl', '-t', '60', 'await_online_nodes', '3');
  });
  await startWorkers('messenger-command-processor');
  const recovered = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === pendingRequestId, 30000);
  const chatId = (recovered.event ?? recovered).chatId;
  compose('exec', '-T', survivingNode, 'rabbitmqctl', 'close_all_connections', '--global', 'resilience test reconnect');

  const requestId = ulid();
  let confirmed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const after = senderSocket.frames.length;
    senderSocket.send({ type: 'send', recipientId: recipient.user.id, requestId, body: 'Saved after queue leader failure' });
    const response = await senderSocket.waitFor((frame) => frame.requestId === requestId &&
      (frame.type === 'queued' || frame.type === 'error'), 15000, after);
    if ((response.event ?? response).type === 'queued') {
      confirmed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(confirmed, 'publisher did not confirm after its broker stopped');
  await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId, 30000);
  const history = await api(`/chats/${chatId}/messages?afterSeq=0`, { cookie: recipient.cookie });
  assert.deepEqual(history.messages.map((message) => message.body), ['Confirmed before queue leader failure', 'Saved after queue leader failure']);
  assert.equal((await api(`/sends/${pendingRequestId}`, { cookie: sender.cookie })).status, 'SAVED');
  const status = await api(`/sends/${requestId}`, { cookie: sender.cookie });
  assert.equal(status.status, 'SAVED');
});
