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
