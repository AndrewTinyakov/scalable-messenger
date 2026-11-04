import { ulid } from './fixtures.mjs';

export async function establishDirect(sender, recipient, senderSocket, recipientSocket) {
  const requestId = ulid();
  senderSocket.send({ type: 'send', recipientId: recipient.user.id, requestId, body: 'Open direct chat' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  return { id: (received.event ?? received).chatId };
}
