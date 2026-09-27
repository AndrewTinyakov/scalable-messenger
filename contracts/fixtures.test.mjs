import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const root = new URL('./', import.meta.url);
const readJSON = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = (path) => ajv.compile(YAML.parse(readFileSync(new URL(path, root), 'utf8')));

const command = validate('schemas/message/command/send-message-v1.yaml');
const saved = validate('schemas/message/event/message-saved-v1.yaml');
const rejected = validate('schemas/message/event/send-rejected-v1.yaml');
const created = validate('schemas/message/event/chat-created-v1.yaml');
const removed = validate('schemas/message/event/member-removed-v1.yaml');
const sessionRevoked = validate('schemas/message/event/session-revoked-v1.yaml');
const socketSend = validate('schemas/socket/frame/send-v1.yaml');
const socketCreated = validate('schemas/socket/frame/chat-created-v1.yaml');
const socketRemoved = validate('schemas/socket/frame/member-removed-v1.yaml');
const socketSubscribe = validate('schemas/socket/frame/subscribe-v1.yaml');
const socketSubscribeMany = validate('schemas/socket/frame/subscribe-many-v1.yaml');
const socketDismissed = validate('schemas/socket/frame/dismissed-v1.yaml');
const socketReceivedMessage = validate('schemas/socket/frame/received-message-v1.yaml');
const socketUnsubscribe = validate('schemas/socket/frame/unsubscribe-v1.yaml');
const socketSubscriptionExpired = validate('schemas/socket/frame/subscription-expired-v1.yaml');
const socketSaved = validate('schemas/socket/frame/message-saved-v1.yaml');
const socketRejected = validate('schemas/socket/frame/send-rejected-v1.yaml');
const socketQueued = validate('schemas/socket/frame/queued-v1.yaml');
const socketSubscribed = validate('schemas/socket/frame/subscribed-v1.yaml');
const socketRecoveryFailed = validate('schemas/socket/frame/recovery-failed-v1.yaml');
const socketError = validate('schemas/socket/frame/error-v1.yaml');

test('shared wire fixtures match their schemas', () => {
  assert.equal(command(readJSON('fixtures/valid/send-command.json')), true, JSON.stringify(command.errors));
  assert.equal(command(readJSON('fixtures/valid/direct-send-command.json')), true, JSON.stringify(command.errors));
  assert.equal(created(readJSON('fixtures/valid/chat-created.json')), true, JSON.stringify(created.errors));
  assert.equal(removed(readJSON('fixtures/valid/member-removed.json')), true, JSON.stringify(removed.errors));
  assert.equal(sessionRevoked(readJSON('fixtures/valid/session-revoked.json')), true, JSON.stringify(sessionRevoked.errors));
  assert.equal(saved(readJSON('fixtures/valid/message-saved.json')), true, JSON.stringify(saved.errors));
  assert.equal(rejected(readJSON('fixtures/valid/send-rejected.json')), true, JSON.stringify(rejected.errors));
});

test('strict contracts reject malformed command and event data', () => {
  const validCommand = readJSON('fixtures/valid/send-command.json');
  const validSaved = readJSON('fixtures/valid/message-saved.json');
  const validRejected = readJSON('fixtures/valid/send-rejected.json');
  assert.equal(command(readJSON('fixtures/invalid/unknown-field-command.json')), false);
  assert.equal(command({ ...validCommand, senderId: 'not-an-ulid' }), false);
  assert.equal(command({ ...validCommand, body: null }), false);
  assert.equal(command({ ...validCommand, sentAt: 'yesterday' }), false);
  assert.equal(command({ ...validCommand, requestId: undefined }), false);
  const directCommand = readJSON('fixtures/valid/direct-send-command.json');
  assert.equal(command({ ...directCommand, recipientId: 'not-an-ulid' }), false);
  assert.equal(socketSend({ type: 'send', version: 1, recipientId: directCommand.recipientId, requestId: directCommand.requestId, body: directCommand.body }), true, JSON.stringify(socketSend.errors));
  assert.equal(socketSend({ type: 'send', version: 1, chatId: validCommand.chatId, recipientId: directCommand.recipientId, requestId: validCommand.requestId, body: validCommand.body }), false);
  assert.equal(saved({ ...validSaved, sequence: 9007199254740993 }), false);
  assert.equal(saved({ ...validSaved, sequence: '-1' }), false);
  assert.equal(rejected({ ...validRejected, reason: 'MAYBE' }), false);
  const validRevocation = readJSON('fixtures/valid/session-revoked.json');
  assert.equal(sessionRevoked({ ...validRevocation, sessionId: 'invalid' }), false);
  assert.equal(sessionRevoked({ ...validRevocation, userId: 'extra-field' }), false);
});

test('server socket frame schemas preserve durable and replay metadata', () => {
  const savedEvent = readJSON('fixtures/valid/message-saved.json');
  const rejectedEvent = readJSON('fixtures/valid/send-rejected.json');
  const createdEvent = readJSON('fixtures/valid/chat-created.json');
  const removedEvent = readJSON('fixtures/valid/member-removed.json');
  const cursor = { epoch: '01ARZ3NDEKTSV4RRFFQ69G5FAY', streamId: '1758877201000-0' };
  assert.equal(socketSaved({ ...savedEvent, ...cursor }), true, JSON.stringify(socketSaved.errors));
  assert.equal(socketRejected({ ...rejectedEvent, ...cursor }), true, JSON.stringify(socketRejected.errors));
  assert.equal(socketCreated({ ...createdEvent, ...cursor }), true, JSON.stringify(socketCreated.errors));
  assert.equal(socketRemoved({ ...removedEvent, ...cursor }), true, JSON.stringify(socketRemoved.errors));
  assert.equal(socketSubscribe({ type: 'subscribe', version: 1, kind: 'group', chatId: createdEvent.chatId }), true, JSON.stringify(socketSubscribe.errors));
  assert.equal(socketSubscribeMany({ type: 'subscribe_many', version: 1, subscriptions: [{ kind: 'group', chatId: createdEvent.chatId }] }), true, JSON.stringify(socketSubscribeMany.errors));
  assert.equal(socketSubscribeMany({ type: 'subscribe_many', version: 1, subscriptions: [] }), false);
  assert.equal(socketSubscribe({ type: 'subscribe', version: 1, chatId: createdEvent.chatId }), false);
  assert.equal(socketUnsubscribe({ type: 'unsubscribe', version: 1, chatId: createdEvent.chatId }), true, JSON.stringify(socketUnsubscribe.errors));
  assert.equal(socketDismissed({ type: 'dismissed', version: 1, chatId: createdEvent.chatId, sequence: '9007199254740993' }), true, JSON.stringify(socketDismissed.errors));
  assert.equal(socketDismissed({ type: 'dismissed', version: 1, chatId: createdEvent.chatId, sequence: '0' }), false);
  assert.equal(socketDismissed({ type: 'dismissed', version: 1, chatId: createdEvent.chatId, sequence: '2', epoch: 'old' }), false);
  assert.equal(socketReceivedMessage({ type: 'received_message', version: 1, chatId: createdEvent.chatId, sequence: '9007199254740993' }), true, JSON.stringify(socketReceivedMessage.errors));
  assert.equal(socketReceivedMessage({ type: 'received_message', version: 1, chatId: createdEvent.chatId, sequence: '0' }), false);
  assert.equal(socketReceivedMessage({ type: 'received_message', version: 1, chatId: createdEvent.chatId, sequence: '2', streamId: 'old' }), false);
  assert.equal(socketSubscriptionExpired({ type: 'subscription_expired', version: 1, chatId: createdEvent.chatId }), true, JSON.stringify(socketSubscriptionExpired.errors));
  assert.equal(socketCreated({ ...createdEvent, ...cursor, room: 'group:' + createdEvent.chatId }), false);
  assert.equal(socketQueued({
    type: 'queued', version: 1, chatId: savedEvent.chatId, requestId: savedEvent.requestId,
  }), true, JSON.stringify(socketQueued.errors));
  assert.equal(socketSubscribed({
    type: 'subscribed', version: 1, chatId: savedEvent.chatId, room: savedEvent.room,
  }), true, JSON.stringify(socketSubscribed.errors));
  assert.equal(socketRecoveryFailed({
    type: 'recovery_failed', version: 1, chatId: savedEvent.chatId,
  }), true, JSON.stringify(socketRecoveryFailed.errors));
  assert.equal(socketError({ type: 'error', version: 1, code: 'invalid_frame' }), true, JSON.stringify(socketError.errors));
  assert.equal(socketSaved({ ...savedEvent, ...cursor, sequence: 9007199254740993 }), false);
  assert.equal(socketRejected({ ...rejectedEvent, ...cursor, reason: 'MAYBE' }), false);
  assert.equal(socketQueued({ type: 'queued', version: 1, requestId: savedEvent.requestId }), false);
});
