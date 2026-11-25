import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, fromFile } from '@asyncapi/parser';
import { GO_COMMON_PRESET, GoFileGenerator, KotlinFileGenerator } from '@asyncapi/modelina';

const root = fileURLToPath(new URL('../', import.meta.url));
const language = process.argv[2];
const targets = {
  kotlin: {
    generator: () => new KotlinFileGenerator(),
    packageName: 'com.andrewtinyakov.messenger.generated.messaging',
    clean: 'kotlin/shared/src/generated/asyncapi/kotlin',
    output: 'kotlin/shared/src/generated/asyncapi/kotlin/com/andrewtinyakov/messenger/generated/messaging',
  },
  go: {
    generator: () => new GoFileGenerator({ presets: [{ preset: GO_COMMON_PRESET, options: { addJsonTag: true } }] }),
    packageName: 'messaging',
    clean: 'ws/internal/generated/messaging',
    output: 'ws/internal/generated/messaging',
  },
};
const target = targets[language];
if (!target && language !== 'validate') throw new Error('Usage: node contracts/generate-models.mjs <validate|kotlin|go>');

const run = (binary, args) => execFileSync(binary, args, { cwd: root, stdio: 'inherit' });

function strictGoEnumDecoder(source) {
  const enumName = source.match(/^type (\w+) uint$/m)?.[1];
  if (!enumName) return source;
  const decoder = new RegExp(`func \\(op \\*${enumName}\\) UnmarshalJSON\\(raw \\[\\]byte\\) error \\{[\\s\\S]*?\\n\\}`);
  if (!decoder.test(source) || !source.includes('"encoding/json"')) {
    throw new Error(`Unsupported generated enum decoder: ${enumName}`);
  }
  return source.replace('"encoding/json"', '"encoding/json"\n"fmt"').replace(decoder,
    `func (op *${enumName}) UnmarshalJSON(raw []byte) error {
    var value *string
    if err := json.Unmarshal(raw, &value); err != nil { return err }
    if value == nil { return fmt.Errorf("${enumName} must be a string") }
    decoded, ok := ValuesTo${enumName}[*value]
    if !ok { return fmt.Errorf("invalid ${enumName}: %q", *value) }
    *op = decoded
    return nil
}`);
}

const pascal = (value) => value.toLowerCase().split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join('');

function vocabularies(document) {
  const frames = new Set();
  const events = new Set();
  const rooms = new Set();
  const frameShapes = {};
  const roomShapes = {};
  let chatKinds;
  for (const message of document.allMessages().all()) {
    const schema = message.payload().json();
    const discriminator = schema.properties?.type?.const;
    if (discriminator) {
      if (message.name().startsWith('Socket')) {
        const direction = schema['x-messenger-direction'];
        if (!['client', 'server'].includes(direction)) throw new Error(`Missing socket direction: ${message.name()}`);
        (direction === 'client' ? frames : events).add(discriminator);
        if (direction === 'client') frameShapes[discriminator] = wireShape(schema);
      } else {
        events.add(discriminator);
        rooms.add(discriminator);
        roomShapes[discriminator] = wireShape(schema);
      }
    }
    const kinds = schema.properties?.kind?.enum;
    if (kinds) {
      if (chatKinds && JSON.stringify(chatKinds) !== JSON.stringify(kinds)) throw new Error('Inconsistent chat kinds');
      chatKinds = kinds;
    }
  }
  if (!chatKinds?.length) throw new Error('Missing chat kind vocabulary');
  return { frameShapes, roomShapes, frames: [...frames].sort(), events: [...events].sort(), rooms: [...rooms].sort(), chatKinds };
}

function wireShape(schema) {
  const required = schema.required ?? [];
  return { required, optional: Object.keys(schema.properties ?? {}).filter((name) => !required.includes(name)) };
}

function kotlinConstants(source, schema) {
  const constants = new Map(Object.entries(schema.properties ?? {}).filter(([, property]) => property.const !== undefined));
  if (!constants.size) return source;
  const name = schema.title;
  const fields = [...source.matchAll(/^    val (\w+): ([^\n]+),$/gm)].map((match) => ({ name: match[1], declaration: match[2] }));
  const parameters = fields.filter((field) => !constants.has(field.name)).map((field) => `            ${field.name}: ${field.declaration},`).join('\n');
  const argumentsList = fields.map((field) => {
    const property = constants.get(field.name);
    const expression = property ? (field.name === 'type' ? `RoomEventType.${property.const.toUpperCase()}.value` : JSON.stringify(property.const)) : field.name;
    return `            ${field.name} = ${expression},`;
  }).join('\n');
  const predicates = [...constants].map(([field, property]) => `${field} == ${JSON.stringify(property.const)}`);
  if (schema['x-messenger-group-room']) predicates.push('room == "group:$chatId"');
  return source.replace(/\)\s*$/, `) {\n    init {\n        require(${predicates.join(' && ')})\n    }\n\n    companion object {\n        fun create(\n${parameters}\n        ): ${name} = ${name}(\n${argumentsList}\n        )\n    }\n}\n`);
}

function writeVocabularies(output, vocabulary, language) {
  if (language === 'go') {
    const constants = (type, prefix, values) => values.map((value) => `    ${prefix}${pascal(value)} ${type} = ${JSON.stringify(value)}`).join('\n');
    writeFileSync(join(output, 'vocabulary.go'), `package messaging\n\ntype EventType string\ntype RoomEventType = EventType\ntype FrameType string\ntype ChatKind string\n\nconst (\n${constants('EventType', 'Event', vocabulary.events)}\n)\n\nconst (\n${constants('FrameType', 'Frame', vocabulary.frames)}\n)\n\nconst (\n${constants('ChatKind', 'Chat', vocabulary.chatKinds)}\n)\n`);
    const goStrings = (values) => `[]string{${values.map((value) => JSON.stringify(value)).join(',')}}`;
    const shapes = (name, type, values) => `var ${name} = map[${type}]WireShape{\n${Object.entries(values).map(([key, shape]) => `  ${JSON.stringify(key)}: {Required:${goStrings(shape.required)}, Optional:${goStrings(shape.optional)}},`).join('\n')}\n}\n`;
    writeFileSync(join(output, 'wire_shapes.go'), `package messaging\n\ntype WireShape struct { Required []string; Optional []string }\n\n${shapes('FrameShapes', 'FrameType', vocabulary.frameShapes)}\n${shapes('RoomShapes', 'EventType', vocabulary.roomShapes)}`);
    return;
  }
  const directory = join(output, 'event');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'RoomEventType.kt'), `package ${target.packageName}.event\n\nenum class RoomEventType(val value: String) {\n${vocabulary.rooms.map((value) => `    ${value.toUpperCase()}(${JSON.stringify(value)}),`).join('\n')}\n}\n`);
  writeFileSync(join(directory, 'ChatKind.kt'), `package ${target.packageName}.event\n\nenum class ChatKind {\n${vocabulary.chatKinds.map((value) => `    ${value},`).join('\n')}\n}\n`);
}

const documents = await Promise.all(['asyncapi.yaml', 'models.asyncapi.yaml'].map(async (file) => {
  const { document, diagnostics } = await fromFile(new Parser(), join(root, 'contracts', file)).parse();
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 0);
  if (!document || errors.length > 0) {
    throw new Error(`${file}: ${JSON.stringify(errors)}`);
  }
  return document;
}));
const vocabulary = vocabularies(documents[0]);
const typeScriptVocabulary = (name, values) => `export const ${name} = {\n${values.map((value) => `  ${value.toUpperCase()}: ${JSON.stringify(value)},`).join('\n')}\n} as const\n\nexport type ${name} = (typeof ${name})[keyof typeof ${name}]\n`;
if (language === 'validate') {
  console.log('AsyncAPI contracts are valid');
  process.exit(0);
}
writeFileSync(join(root, 'client/src/shared/api/generated/socket-vocabulary.ts'),
  [typeScriptVocabulary('FrameType', vocabulary.frames), typeScriptVocabulary('EventType', vocabulary.events), typeScriptVocabulary('ChatKind', vocabulary.chatKinds)].join('\n'));
const temp = mkdtempSync(join(tmpdir(), 'messenger-asyncapi-'));
try {
  const output = join(temp, 'models');
  const schemas = new Map(documents[1].allMessages().all().map((message) => [message.name(), message.payload().json()]));
  for (const name of ['SendMessageCommandV1', 'SendRejectedEventV1', 'PinsChangedEventV1', 'ChatPreferencesChangedEventV1', 'MemberRemovedEventV1']) {
    delete documents[1].components().messages().get(name).payload().json().oneOf;
  }
  delete documents[1].components().messages().get('HistoryChangedEventV1').payload().json().anyOf;
  for (const name of ['MessageSavedEventV1', 'MessageChangedEventV1']) {
    delete documents[1].components().messages().get(name).payload().json().allOf;
  }
  await target.generator().generateToFiles(documents[1], output, { packageName: target.packageName });

  if (language === 'kotlin') {
    for (const file of readdirSync(output)) {
      if (!file.endsWith('.kt')) continue;
      const group = file.includes('Command') ? 'command' : 'event';
      const source = join(output, file);
      const destination = join(output, group);
      mkdirSync(destination, { recursive: true });
      writeFileSync(source, kotlinConstants(readFileSync(source, 'utf8'), schemas.get(file.slice(0, -3)) ?? {})
        .replace(`package ${target.packageName}`, `package ${target.packageName}.${group}`)
        .replace(/[ \t]+$/gm, ''));
      renameSync(source, join(destination, file));
    }
  } else {
    for (const file of readdirSync(output)) {
      if (!file.endsWith('.go')) continue;
      const path = join(output, file);
      writeFileSync(path, strictGoEnumDecoder(readFileSync(path, 'utf8')));
    }
  }
  writeVocabularies(output, vocabulary, language);
  if (language === 'go') run('gofmt', ['-w', output]);
  rmSync(join(root, target.clean), { recursive: true, force: true });
  cpSync(output, join(root, target.output), { recursive: true });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
