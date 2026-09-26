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
const socketSaved = validate('schemas/socket/frame/message-saved-v1.yaml');
const socketRejected = validate('schemas/socket/frame/send-rejected-v1.yaml');
const socketQueued = validate('schemas/socket/frame/queued-v1.yaml');
const socketSubscribed = validate('schemas/socket/frame/subscribed-v1.yaml');
const socketRecoveryFailed = validate('schemas/socket/frame/recovery-failed-v1.yaml');
const socketError = validate('schemas/socket/frame/error-v1.yaml');

test('shared wire fixtures match their schemas', () => {
  assert.equal(command(readJSON('fixtures/valid/send-command.json')), true, JSON.stringify(command.errors));
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
  assert.equal(saved({ ...validSaved, sequence: 9007199254740993 }), false);
  assert.equal(saved({ ...validSaved, sequence: '-1' }), false);
  assert.equal(rejected({ ...validRejected, reason: 'MAYBE' }), false);
});

test('server socket frame schemas preserve durable and replay metadata', () => {
  const savedEvent = readJSON('fixtures/valid/message-saved.json');
  const rejectedEvent = readJSON('fixtures/valid/send-rejected.json');
  const cursor = { epoch: '01ARZ3NDEKTSV4RRFFQ69G5FAY', streamId: '1758877201000-0' };
  assert.equal(socketSaved({ ...savedEvent, ...cursor }), true, JSON.stringify(socketSaved.errors));
  assert.equal(socketRejected({ ...rejectedEvent, ...cursor }), true, JSON.stringify(socketRejected.errors));
  assert.equal(socketQueued({
    type: 'queued', version: 1, conversationId: savedEvent.conversationId, requestId: savedEvent.requestId,
  }), true, JSON.stringify(socketQueued.errors));
  assert.equal(socketSubscribed({
    type: 'subscribed', version: 1, conversationId: savedEvent.conversationId, room: savedEvent.room,
  }), true, JSON.stringify(socketSubscribed.errors));
  assert.equal(socketRecoveryFailed({
    type: 'recovery_failed', version: 1, conversationId: savedEvent.conversationId,
  }), true, JSON.stringify(socketRecoveryFailed.errors));
  assert.equal(socketError({ type: 'error', version: 1, code: 'invalid_frame' }), true, JSON.stringify(socketError.errors));
  assert.equal(socketSaved({ ...savedEvent, ...cursor, sequence: 9007199254740993 }), false);
  assert.equal(socketRejected({ ...rejectedEvent, ...cursor, reason: 'MAYBE' }), false);
  assert.equal(socketQueued({ type: 'queued', version: 1, requestId: savedEvent.requestId }), false);
});
