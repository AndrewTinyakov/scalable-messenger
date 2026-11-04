import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const language = process.argv[2];
const targets = {
  kotlin: {
    generator: 'kotlin',
    packageName: 'com.andrewtinyakov.messenger.generated.messaging',
    clean: 'kotlin/shared/src/generated/asyncapi/kotlin',
    output: 'kotlin/shared/src/generated/asyncapi/kotlin/com/andrewtinyakov/messenger/generated/messaging',
  },
  go: {
    generator: 'golang',
    packageName: 'messaging',
    clean: 'ws/internal/generated/messaging',
    output: 'ws/internal/generated/messaging',
  },
};
const target = targets[language];
if (!target) throw new Error('Usage: node contracts/generate-models.mjs <kotlin|go>');

const asyncapi = join(root, 'node_modules', '.bin', 'asyncapi');
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

run(asyncapi, ['validate', 'contracts/asyncapi.yaml']);
run(asyncapi, ['validate', 'contracts/models.asyncapi.yaml']);
const temp = mkdtempSync(join(tmpdir(), 'messenger-asyncapi-'));
try {
  const bundled = join(temp, 'models.yaml');
  run(asyncapi, ['bundle', 'contracts/models.asyncapi.yaml', '--output', bundled]);
  rmSync(join(root, target.clean), { recursive: true, force: true });
  run(asyncapi, ['generate', 'models', target.generator, bundled, '--packageName', target.packageName,
    '--output', target.output, '--no-interactive', ...(language === 'go' ? ['--goIncludeTags'] : [])]);

  if (language === 'kotlin') {
    for (const file of readdirSync(join(root, target.output))) {
      if (!file.endsWith('.kt')) continue;
      const group = file.includes('Command') ? 'command' : 'event';
      const source = join(root, target.output, file);
      const destination = join(root, target.output, group);
      mkdirSync(destination, { recursive: true });
      writeFileSync(source, readFileSync(source, 'utf8')
        .replace(`package ${target.packageName}`, `package ${target.packageName}.${group}`)
        .replace(/[ \t]+$/gm, ''));
      renameSync(source, join(destination, file));
    }
  } else {
    for (const file of readdirSync(join(root, target.output))) {
      if (!file.endsWith('.go')) continue;
      const path = join(root, target.output, file);
      writeFileSync(path, strictGoEnumDecoder(readFileSync(path, 'utf8')));
    }
    run('go', ['-C', 'ws', 'fmt', './internal/generated/messaging']);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
