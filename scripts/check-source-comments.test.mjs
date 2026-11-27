import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkSource } from './check-source-comments.mjs'

function expectComments(path, lines, ...locations) {
  assert.deepEqual(checkSource(path, lines.join('\n')), locations.map((location) => `${path}:${location}: source comment`))
}

test('JavaScript and TypeScript find trailing comments without reading strings, templates or regexes as comments', () => {
  expectComments('scripts/sample.mjs', [
    '#!/usr/bin/env node',
    'const regex = /[//]/u;',
    'const url = "https://example.com/a#b";',
    'const template = `https://example.com/${url}`;',
    'const value = 1; // trailing',
    'const interpolation = `${value /* inside expression */}`;',
  ], '5:18', '6:32')
  expectComments('client/src/sample.ts', ['const value: number = 1; // trailing'], '1:26')
})

test('JSX distinguishes text, attributes and comments in expressions', () => {
  expectComments('client/src/sample.tsx', [
    'const link = <a href="https://example.com">https://example.com/* text */</a>;',
    'const component = <div>{/* JSX comment */}</div>;',
  ], '2:25')
})

test('only the exact Vite reference at the top of its declaration file is allowed', () => {
  const reference = '/// <reference types="vite/client" />'
  expectComments('client/src/vite-env.d.ts', [reference, 'interface ImportMeta {}'])
  expectComments('client/src/vite-env.d.ts', ['', reference], '2:1')
  expectComments('client/src/vite-env.d.ts', [reference + ' extra'], '1:1')
  expectComments('client/src/other.d.ts', [reference], '1:1')
  expectComments('client/src/sample.ts', ['/* eslint-disable */', 'export {}'], '1:1')
})

test('YAML keeps hashes in plain, quoted and block scalars', () => {
  expectComments('deploy/sample.yaml', [
    'url: https://example.com/#heading',
    'secret: "# as data"',
    'script: | # block header',
    '  # part of the scalar',
    '  printf "%s\\n" "# still in the scalar"',
    'other: [1, 2] # trailing',
    '# last',
  ], '3:11', '6:15', '7:1')
})

test('PostgreSQL keeps comment markers in strings, escape strings, quoted identifiers and dollar quotes', () => {
  expectComments('db/sample.sql', [
    "SELECT '-- text', 'it''s /* text */', \"-- quoted identifier\";",
    String.raw`SELECT E'it\'s -- text', e'\\', '-- text';`,
    "SELECT $$ -- data with ' and /* $$, $tag$ /* data */ $$ $tag$;",
    'SELECT an$identifier$ FROM t; -- actual comment',
    '/* outer /* nested */ still outer */ SELECT 1; -- second',
  ], '4:31', '5:1', '5:48')
})

test('PostgreSQL scans executable dollar-quoted routine bodies at their original positions', () => {
  expectComments('db/sample.sql', [
    'CREATE OR REPLACE FUNCTION language() RETURNS text AS $fn$',
    '  SELECT $$-- literal$$; -- SQL body',
    '$fn$ LANGUAGE sql;',
    'DO LANGUAGE plpgsql $$',
    'BEGIN',
    "  RAISE NOTICE '-- literal'; /* procedural body */",
    'END',
    '$$;',
    'CREATE PROCEDURE external() AS $$ C source /* data */ $$ LANGUAGE c;',
  ], '2:26', '6:30')
})

test('PostgreSQL scans single-quoted routine bodies and reports positions in the original text', () => {
  expectComments('db/sample.sql', [
    "CREATE FUNCTION f() RETURNS text LANGUAGE 'sql' AS 'SELECT ''-- literal''; -- body",
    "/* second */';",
    String.raw`DO E'BEGIN RAISE NOTICE \'-- literal\';\n\x2d\055 body\nEND';`,
    "CREATE PROCEDURE external() AS 'source /* data */' LANGUAGE c;",
    "CREATE FUNCTION split() RETURNS int AS 'SELECT 1; /' -- outside",
    "  '* body */' LANGUAGE sql;",
    "CREATE FUNCTION unicode() RETURNS int AS U&'SELECT 1 !002f!002a body */' UESCAPE '!' LANGUAGE e'sql';",
  ], '1:76', '2:1', '3:42', '5:51', '5:54', '7:54')
})

test('nginx hashes start comments between arguments, including after a directive or block', () => {
  expectComments('deploy/edge/nginx-api.conf', [
    String.raw`set $name "a\"#b"; # trailing`,
    String.raw`return 302 https://example.com/a#b;# after semicolon`,
    String.raw`set $escaped \#literal;`,
    "location / { # after opening brace",
    "  set $single 'a#b';",
    '}# after closing brace',
  ], '1:20', '2:36', '4:14', '6:2')
})

test('CSS and protobuf distinguish comments from quoted or escaped data', () => {
  expectComments('style.css', [
    String.raw`a { content: "a\"/* literal */"; }`,
    String.raw`b { background: u\72 l(https://example.com/a/*literal*/); }`,
    '/* banner */ c { color: #fff; /* inline */ }',
  ], '3:1', '3:31')
  expectComments('api.proto', [
    `syntax = 'proto3'; // trailing`,
    String.raw`option java_package = "a\"//b/*c*/";`,
    '/* block */ message Empty {}',
  ], '1:20', '3:1')
})

test('HTML and SVG distinguish comments from attributes, raw text and CDATA', () => {
  expectComments('index.html', [
    '<!doctype html>',
    '<p title="<!-- attribute -->">literal text</p>',
    '<textarea><!-- raw text --></textarea>',
    '<script>const message = "<!-- data -->";</script>',
    '<template><!-- inside template --></template>',
    '<!-- after template -->',
    '<style>p { content: "/* literal */"; /* embedded */ }</style>',
  ], '5:11', '6:1', '7:38')
  expectComments('icon.svg', [
    '<?xml version="1.0"?>',
    '<svg><![CDATA[<!-- data -->]]><!-- real --><!-- next --></svg>',
  ], '2:31', '2:44')
})

test('Dockerfiles allow unique parser directives in the header and keep heredoc lines as instruction data', () => {
  expectComments('Dockerfile', [
    '# syntax=docker/dockerfile:1',
    '# escape=`',
    'FROM base',
    'RUN printf "# literal" `',
    '  # continuation comment',
    '  "# second literal"',
    "COPY <<-'DATA' /example",
    '\t# file content',
    '\tDATA',
    '  # escape=\\',
  ], '5:3', '10:3')
  expectComments('build/Dockerfile.dev', ['', '# syntax=docker/dockerfile:1', 'FROM base'], '2:1')
  expectComments('build/dev.Dockerfile', ['# escape=\\', '# escape=\\', 'FROM base'], '2:1')
})

test('properties, EditorConfig and ignore files use their own line comment rules', () => {
  expectComments('application.properties', [
    'path=a\\',
    '  # part of the value',
    'text="quoted value" # inline text',
    String.raw`\#escaped=key`,
    ' ! Java properties comment',
  ], '5:2')
  expectComments('kotlin/gradle/gradle-daemon-jvm.properties', [
    '#This file is generated by updateDaemonJvm',
    'toolchainVersion=25',
    '# other comment',
  ], '3:1')
  expectComments('kotlin/.editorconfig', ['root = true', '[*.kt]', 'indent_size = 4', ' # prose', '; prose'], '4:2', '5:1')
  expectComments('client/.gitignore', [String.raw`\#literal`, ' # filename', '!included', '# comment'], '4:1')
  expectComments('.dockerignore', ['  # filename', 'path#fragment', '# comment'], '3:1')
  expectComments('client/.prettierignore', ['# comment'], '1:1')
})

test('Lua comments respect short strings, long brackets and a leading shebang', () => {
  expectComments('publish.lua', [
    '#!/usr/bin/env lua',
    String.raw`local a = 'it\'s -- literal'`,
    'local b = [=[-- literal ]==] still literal]=] -- trailing',
    '--[==[ block ]=] still block ]==]',
    '-- final',
  ], '3:47', '4:1', '5:1')
})

test('RabbitMQ and Go configuration follow their native comment syntax', () => {
  expectComments('deploy/rabbitmq/rabbitmq.conf', ['key = value# trailing'], '1:12')
  expectComments('deploy/rabbitmq/enabled_plugins', ["['plugin%literal', $%]. % trailing"], '1:25')
  expectComments('ws/go.mod', [
    'module example.com/demo',
    'require (',
    '  example.com/dep v1.2.3 // indirect',
    '  example.com/other v1.2.3 // indirect explanation',
    ')',
    '// prose',
  ], '4:28', '6:1')
})

test('shell handles parameter expansions, word hashes, quotes, substitutions and heredocs', () => {
  expectComments('scripts/sample.sh', [
    '#!/usr/bin/env sh',
    'printf "%s" "${value#prefix}" "${value##prefix}" "${#value}" "${value%#}" f#o \\#',
    "printf '%s' '# quoted' \"é # quoted\" # trailing",
    "cat <<'DATA' <<-MORE # redirection comment",
    '# literal heredoc',
    'DATA',
    '\t# expanding heredoc',
    '\tMORE',
    'value="$(printf foo # inside a substitution',
    ')"',
    '#!/bin/sh',
  ], '3:37', '4:22', '9:21', '11:1')
  expectComments('scripts/bash-script', [
    '#!/usr/bin/env -S bash -eu',
    'printf "%s" "${value//#/x}"',
    '[[ example == example ]] # Bash syntax',
  ], '3:26')
  expectComments('scripts/sample.sh', ['#! no interpreter here', 'echo ok'], '1:1')
})

test('the historical Flyway exception requires the exact migration bytes at its tracked path', () => {
  const path = 'kotlin/shared/src/main/resources/db/migration/V16__outbox_wakeup_after_commit.sql'
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  assert.deepEqual(checkSource(path, source), [])
  assert.deepEqual(checkSource(path, source.replace('database-wide', 'database wide')), [
    `${path}:1:1: historical Flyway migration checksum changed`,
  ])
  expectComments('db/copy.sql', [source], '1:1', '2:1')
})

test('invalid syntax fails the check with a source location', () => {
  for (const [path, source, location] of [
    ['script.ts', 'const x =', '1:10'],
    ['config.yaml', 'key: [\n', '2:1'],
    ['migration.sql', '\n /* unterminated', '2:2'],
    ['script.sh', 'echo "unterminated', '1:6'],
  ]) {
    const [finding] = checkSource(path, source)
    assert.ok(finding.startsWith(`${path}:${location}: could not scan source: `), finding)
  }
})

test('the CLI reports tracked comments and skips untracked files and generated paths', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'messenger-source-comments-'))
  t.after(() => rmSync(cwd, { force: true, recursive: true }))
  const git = (...args) => execFileSync('git', args, { cwd })
  git('init', '--quiet')
  const tracked = 'scripts/tracked name.mjs'
  const handwritten = 'client/src/generated/handwritten.ts'
  const sibling = 'client/src/shared/api/generated/handwritten.ts'
  const nginx = 'deploy/nginx/custom.conf'
  for (const path of [
    tracked,
    handwritten,
    sibling,
    nginx,
    'scripts/untracked.mjs',
    'client/src/shared/api/generated/schema.d.ts',
    'client/src/shared/api/generated/socket-vocabulary.ts',
    'kotlin/shared/src/generated/output.mjs',
    'ws/internal/generated/output.mjs',
    'contracts/openapi.yaml',
    'kotlin/gradlew',
    'tests/sidebar-benchmark/sidebar-page.sql',
  ]) {
    mkdirSync(join(cwd, path, '..'), { recursive: true })
    writeFileSync(join(cwd, path), '// comment\n# comment\n-- comment\n')
    if (path !== 'scripts/untracked.mjs') git('add', '--', path)
  }
  const checker = fileURLToPath(new URL('./check-source-comments.mjs', import.meta.url))
  const run = () => spawnSync(process.execPath, [checker], { cwd, encoding: 'utf8' })
  writeFileSync(join(cwd, tracked), 'export {}; // tracked\n')
  writeFileSync(join(cwd, handwritten), '// handwritten\n')
  writeFileSync(join(cwd, sibling), '// handwritten\n')
  writeFileSync(join(cwd, nginx), '# nginx comment\n')
  const rejected = run()
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.equal(rejected.stderr.trim(), [
    `${handwritten}:1:1: source comment`,
    `${sibling}:1:1: source comment`,
    `${nginx}:1:1: source comment`,
    `${tracked}:1:12: source comment`,
  ].join('\n'))
  writeFileSync(join(cwd, tracked), 'export {};\n')
  writeFileSync(join(cwd, handwritten), 'export {};\n')
  writeFileSync(join(cwd, sibling), 'export {};\n')
  writeFileSync(join(cwd, nginx), 'worker_processes auto;\n')
  const passed = run()
  assert.equal(passed.status, 0, passed.stderr)
  assert.equal(passed.stderr, '')
})
