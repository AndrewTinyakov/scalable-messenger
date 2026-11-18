import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const root = new URL('./', import.meta.url);
const readJSON = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addKeyword({
  keyword: 'x-messenger-group-room',
  type: 'object',
  validate: (enabled, value) => !enabled || value.room === `group:${value.chatId}`,
});
ajv.addSchema(YAML.parse(readFileSync(new URL('schemas/common/chat-kind.yaml', root), 'utf8')), new URL('schemas/common/chat-kind.yaml', root).href);
addFormats(ajv);
const validate = (path) => ajv.compile({
  ...YAML.parse(readFileSync(new URL(path, root), 'utf8')),
  $id: new URL(path, root).href,
});

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
  assert.equal(command({ ...validCommand, chatId: undefined }), false);
  assert.equal(command({ ...validCommand, recipientId: directCommand.recipientId }), false);
  assert.equal(socketSend({ type: 'send', version: 1, recipientId: directCommand.recipientId, requestId: directCommand.requestId, body: directCommand.body }), true, JSON.stringify(socketSend.errors));
  assert.equal(socketSend({ type: 'send', version: 1, chatId: validCommand.chatId, recipientId: directCommand.recipientId, requestId: validCommand.requestId, body: validCommand.body }), false);
  assert.equal(saved({ ...validSaved, sequence: 9007199254740993 }), false);
  assert.equal(saved({ ...validSaved, sequence: '-1' }), false);
  assert.equal(rejected({ ...validRejected, reason: 'MAYBE' }), false);
  assert.equal(rejected(readJSON('fixtures/invalid/send-rejected-both-targets.json')), false);
  assert.equal(rejected({ ...validRejected, chatId: undefined }), false);
  const validRevocation = readJSON('fixtures/valid/session-revoked.json');
  assert.equal(sessionRevoked({ ...validRevocation, sessionId: 'invalid' }), false);
  assert.equal(sessionRevoked({ ...validRevocation, userId: 'extra-field' }), false);
  const validRemoval = readJSON('fixtures/valid/member-removed.json');
  assert.equal(removed({ ...validRemoval, memberId: undefined }), false);
  assert.equal(removed({ ...validRemoval, room: `group:${validRemoval.chatId}` }), true, JSON.stringify(removed.errors));
});

test('server socket frame schemas preserve durable and replay metadata', () => {
  const savedEvent = readJSON('fixtures/valid/message-saved.json');
  const rejectedEvent = readJSON('fixtures/valid/send-rejected.json');
  const createdEvent = readJSON('fixtures/valid/chat-created.json');
  const removedEvent = readJSON('fixtures/valid/member-removed.json');
  assert.equal(socketRemoved({ ...removedEvent, room: `group:${removedEvent.chatId}`, epoch: 'epoch', streamId: '1-0' }), true, JSON.stringify(socketRemoved.errors));
  const cursor = { epoch: '01ARZ3NDEKTSV4RRFFQ69G5FAY', streamId: '1758877201000-0' };
  assert.equal(socketSaved({ ...savedEvent, ...cursor }), true, JSON.stringify(socketSaved.errors));
  assert.equal(socketRejected({ ...rejectedEvent, ...cursor }), true, JSON.stringify(socketRejected.errors));
  assert.equal(socketCreated({ ...createdEvent, ...cursor }), true, JSON.stringify(socketCreated.errors));
  assert.equal(socketRemoved({ ...removedEvent, ...cursor }), true, JSON.stringify(socketRemoved.errors));
  assert.equal(socketRemoved({ ...removedEvent, ...cursor, memberId: undefined }), false);
  assert.equal(socketSubscribe({ type: 'subscribe', version: 1, kind: 'GROUP', chatId: createdEvent.chatId }), true, JSON.stringify(socketSubscribe.errors));
  assert.equal(socketSubscribeMany({ type: 'subscribe_many', version: 1, subscriptions: [{ kind: 'GROUP', chatId: createdEvent.chatId }] }), true, JSON.stringify(socketSubscribeMany.errors));
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
  assert.equal(socketError({ type: 'error', version: 1, code: 'INVALID_FRAME' }), true, JSON.stringify(socketError.errors));
  assert.equal(socketSaved({ ...savedEvent, ...cursor, sequence: 9007199254740993 }), false);
  assert.equal(socketRejected({ ...rejectedEvent, ...cursor, reason: 'MAYBE' }), false);
  assert.equal(socketQueued({ type: 'queued', version: 1, requestId: savedEvent.requestId }), false);
});

const membershipChanged = validate('schemas/message/event/membership-changed-v1.yaml');
const socketMembershipChanged = validate('schemas/socket/frame/membership-changed-v1.yaml');

test('membership invalidation requires matching group room and strict metadata', () => {
  const event = readJSON('fixtures/valid/membership-changed.json');
  const cursor = { epoch: 'epoch', streamId: '1758877201000-0' };
  assert.equal(membershipChanged(event), true, JSON.stringify(membershipChanged.errors));
  assert.equal(socketMembershipChanged({ ...event, ...cursor }), true);
  for (const invalid of [
    { room: `user:${event.chatId}` },
    { room: 'group:01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    { chatId: undefined }, { eventId: 'invalid' }, { version: 2 },
    { sequence: '1' }, { requestId: event.eventId }, { memberId: event.eventId },
  ]) {
    assert.equal(membershipChanged({ ...event, ...invalid }), false);
    assert.equal(socketMembershipChanged({ ...event, ...cursor, ...invalid }), false);
  }
  assert.equal(membershipChanged({ ...event, ...cursor }), false);
  assert.equal(socketMembershipChanged(event), false);
  assert.equal(socketMembershipChanged({ ...event, ...cursor, epoch: '' }), false);
  assert.equal(socketMembershipChanged({ ...event, ...cursor, streamId: 'invalid' }), false);
});

const changed = validate('schemas/message/event/message-changed-v1.yaml');
const chatDeleted = validate('schemas/message/event/chat-deleted-v1.yaml');
const readsChanged = validate('schemas/message/event/reads-changed-v1.yaml');
const socketChanged = validate('schemas/socket/frame/message-changed-v1.yaml');
const socketPresence = validate('schemas/socket/frame/presence-v1.yaml');
const watchPresence = validate('schemas/socket/frame/watch-presence-v1.yaml');

test('feature fixtures preserve versions, reply identity and empty tombstones', () => {
  for (const name of ['message-saved-reply', 'message-saved-deleted-reply']) {
    assert.equal(saved(readJSON(`fixtures/valid/${name}.json`)), true, JSON.stringify(saved.errors));
  }
  for (const name of ['message-changed', 'message-deleted']) {
    const event = readJSON(`fixtures/valid/${name}.json`);
    assert.equal(changed(event), true, JSON.stringify(changed.errors));
    assert.equal(socketChanged({ ...event, epoch: 'epoch', streamId: '1-0' }), true, JSON.stringify(socketChanged.errors));
    assert.equal(changed({ ...event, messageVersion: 2 }), false);
    assert.equal(changed({ ...event, requestId: event.eventId }), false);
  }
  assert.equal(chatDeleted(readJSON('fixtures/valid/chat-deleted.json')), true);
  assert.equal(readsChanged(readJSON('fixtures/valid/reads-changed.json')), true);
  assert.equal(command(readJSON('fixtures/valid/send-reply-command.json')), true);
  assert.equal(changed({ ...readJSON('fixtures/valid/message-deleted.json'), body: undefined }), false);
  const quote = readJSON('fixtures/valid/message-saved-deleted-reply.json');
  assert.equal(saved({ ...quote, replyBody: 'deleted text' }), false);
  assert.equal(saved({ ...readJSON('fixtures/valid/message-saved.json'), replyBody: '' }), false);
});

test('presence snapshots are bounded, private to a chat and separate from durable events', () => {
  const event = readJSON('fixtures/valid/socket-presence.json');
  assert.equal(socketPresence(event), true, JSON.stringify(socketPresence.errors));
  assert.equal(socketPresence({ ...event, statuses: [] }), true);
  assert.equal(socketPresence({ ...event, validForMs: 0 }), false);
  assert.equal(socketPresence({ ...event, statuses: [{ userId: event.chatId, state: 'maybe' }] }), false);
  assert.equal(socketPresence({ ...event, userId: event.chatId }), false);
  const frame = { type: 'watch_presence', version: 1, chatId: event.chatId, userIds: [event.chatId] };
  assert.equal(watchPresence(frame), true);
  assert.equal(watchPresence({ ...frame, userIds: [event.chatId, event.chatId] }), false);
  assert.equal(watchPresence({ ...frame, body: '' }), false);
  assert.equal(chatDeleted({ ...readJSON('fixtures/valid/chat-deleted.json'), observedAt: '' }), false);
});


test('bodyless recovery hints and viewer-resolved live replies share strict fixtures', () => {
  const hint = validate('schemas/message/event/history-changed-v1.yaml');
  const socketHint = validate('schemas/socket/frame/history-changed-v1.yaml');
  const fixture = readJSON('fixtures/valid/history-changed.json');
  assert.equal(hint(fixture), true, JSON.stringify(hint.errors));
  assert.equal(socketHint({ ...fixture, epoch: 'epoch', streamId: '1-0' }), true);
  assert.equal(hint({ ...fixture, body: 'removed text' }), false);
  assert.equal(hint({ ...fixture, visibilityRevision: 1 }), false);
  const reply = readJSON('fixtures/valid/message-saved-reply-identity.json');
  assert.equal(saved(reply), true, JSON.stringify(saved.errors));
  assert.equal(socketSaved({ ...reply, epoch: 'epoch', streamId: '1-0' }), true);
  assert.equal(saved({ ...reply, replyBody: 'unverified preview' }), false);
  const reference = validate('schemas/message/event/saved-message-reference-v1.yaml');
  const { type, version, eventId, room, chatId, requestId, messageId, sequence } = reply;
  const row = { type, version, eventId, room, chatId, requestId, messageId, sequence };
  assert.equal(reference(row), true);
  assert.equal(reference({ ...row, body: 'retained text' }), false);
});

test('sidebar watch and bodyless observations share strict bounded schemas', () => {
  for (const name of ['watch-sidebar', 'sidebar-activity', 'sidebar-presence']) {
    const schema = validate(`schemas/socket/frame/${name}-v1.yaml`);
    const fixture = readJSON(`fixtures/valid/${name}.json`);
    assert.equal(schema(fixture), true, JSON.stringify(schema.errors));
    assert.equal(schema({ ...fixture, body: 'forbidden' }), false);
  }
  const watch = ajv.getSchema(new URL('schemas/socket/frame/watch-sidebar-v1.yaml', root).href);
  const fixture = readJSON('fixtures/valid/watch-sidebar.json');
  assert.equal(watch({ ...fixture, chatIds: [] }), true);
  assert.equal(watch({ ...fixture, chatIds: null }), false);
  assert.equal(watch({ ...fixture, chatIds: [fixture.chatIds[0], fixture.chatIds[0]] }), false);
  assert.equal(watch({ ...fixture, chatIds: Array.from({length:101}, (_, i) => String(i).padStart(26, '0')) }), false);
});

test('personal chat preferences, message pins and forwards share strict wire fixtures', () => {
  const preferences = validate('schemas/message/event/chat-preferences-changed-v1.yaml');
  const socketPreferences = validate('schemas/socket/frame/chat-preferences-changed-v1.yaml');
  const pins = validate('schemas/message/event/pins-changed-v1.yaml');
  const socketPins = validate('schemas/socket/frame/pins-changed-v1.yaml');
  const changed = readJSON('fixtures/valid/chat-preferences-changed.json');
  const pinned = readJSON('fixtures/valid/pins-changed.json');
  const live = { epoch: 'epoch-1', streamId: '1-0' };
  assert.equal(preferences(changed), true, JSON.stringify(preferences.errors));
  assert.equal(socketPreferences({ ...changed, ...live }), true, JSON.stringify(socketPreferences.errors));
  assert.equal(preferences({ ...changed, room: `group:${changed.chatId}` }), false);
  assert.equal(preferences({ ...changed, mutedUntil: '2026-11-05T10:00:00Z' }), false);
  assert.equal(pins(pinned), true, JSON.stringify(pins.errors));
  assert.equal(pins({ ...pinned, room: 'user:01ARZ3NDEKTSV4RRFFQ69G5FAX' }), true, JSON.stringify(pins.errors));
  assert.equal(socketPins({ ...pinned, ...live }), true, JSON.stringify(socketPins.errors));
  assert.equal(socketPins(pinned), false);

  const forward = readJSON('fixtures/valid/send-forward-command.json');
  assert.equal(command(forward), true, JSON.stringify(command.errors));
  assert.equal(command({ ...forward, forwardFromMessageId: undefined }), false);
  assert.equal(command({ ...forward, replyToMessageId: forward.forwardFromMessageId }), false);
  const { chatId, ...withoutChat } = forward;
  assert.equal(command({ ...withoutChat, recipientId: chatId }), false);
  const frame = { type: 'send', version: 1, chatId, requestId: forward.requestId, body: forward.body, forwardFromChatId: forward.forwardFromChatId, forwardFromMessageId: forward.forwardFromMessageId };
  assert.equal(socketSend(frame), true, JSON.stringify(socketSend.errors));
  assert.equal(socketSend({ ...frame, forwardFromChatId: undefined }), false);

  const forwarded = readJSON('fixtures/valid/message-saved-forward.json');
  assert.equal(saved(forwarded), true, JSON.stringify(saved.errors));
  assert.equal(socketSaved({ ...forwarded, ...live }), true, JSON.stringify(socketSaved.errors));
  assert.equal(saved({ ...forwarded, forwardedFromUserId: 'nobody' }), false);
  assert.equal(rejected({ ...readJSON('fixtures/valid/send-rejected.json'), reason: 'INVALID_FORWARD_SOURCE' }), true, JSON.stringify(rejected.errors));
});
