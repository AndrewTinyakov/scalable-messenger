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
  for (const path of [
    tracked,
    'scripts/untracked.mjs',
    'client/src/shared/api/generated/sample.ts',
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
  const rejected = run()
  assert.equal(rejected.status, 1, rejected.stderr)
  assert.equal(rejected.stderr.trim(), `${tracked}:1:12: source comment`)
  writeFileSync(join(cwd, tracked), 'export {};\n')
  const passed = run()
  assert.equal(passed.status, 0, passed.stderr)
  assert.equal(passed.stderr, '')
})
