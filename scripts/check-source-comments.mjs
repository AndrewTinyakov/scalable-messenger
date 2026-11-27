import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { parse as parseJavaScript } from '@babel/parser'
import { createSourceIndex, LangVariant, parse as parseShell, walk } from 'sh-syntax/sync'
import { Composer, Parser } from 'yaml'
import { postgresComments } from './source-comments/postgres.mjs'

const legacyMigration = 'kotlin/shared/src/main/resources/db/migration/V16__outbox_wakeup_after_commit.sql'
const legacyMigrationSha256 = 'f492bbce0c218d00f35d83ee2e679521543c0b1a4961f9fb076a472bab3525f9'
const viteReference = '/// <reference types="vite/client" />'

const generatedFiles = new Set([
  'contracts/openapi.yaml',
  'kotlin/gradlew',
  'tests/sidebar-benchmark/sidebar-page.sql',
])

const javascriptExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const shellExtensions = new Map([
  ['.sh', LangVariant.LangBash],
  ['.bash', LangVariant.LangBash],
  ['.ksh', LangVariant.LangMirBSDKorn],
  ['.zsh', LangVariant.LangZsh],
  ['.bats', LangVariant.LangBats],
])
const shellInterpreters = new Map([
  ['sh', LangVariant.LangPOSIX],
  ['dash', LangVariant.LangPOSIX],
  ['ash', LangVariant.LangPOSIX],
  ['bash', LangVariant.LangBash],
  ['ksh', LangVariant.LangMirBSDKorn],
  ['zsh', LangVariant.LangZsh],
  ['bats', LangVariant.LangBats],
])

function shellInterpreter(source) {
  if (!source.startsWith('#!')) return undefined
  const [command, ...args] = source.split('\n', 1)[0].slice(2).trim().split(/\s+/)
  const executable = command.split('/').at(-1)
  if (executable !== 'env') return shellInterpreters.get(executable)
  return shellInterpreters.get(args[0] === '-S' ? args[1] : args[0])
}

function javascriptComments(path, source, extension) {
  const plugins = []
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    plugins.push(['typescript', { dts: path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts') }])
  }
  if (extension === '.tsx' || extension === '.jsx') plugins.push('jsx')
  const { comments } = parseJavaScript(source, {
    sourceType: 'unambiguous',
    plugins,
    attachComment: false,
  })
  return comments.filter(({ start, end }) =>
    !(path === 'client/src/vite-env.d.ts' && start === 0 && source.slice(start, end) === viteReference),
  )
}

function yamlComments(source) {
  const tokens = [...new Parser().parse(source)]
  const composer = new Composer()
  const documents = [...composer.compose(tokens)]
  const error = documents.find((document) => document.errors.length)?.errors[0] ??
    composer.streamInfo().errors[0]
  if (error) throw error

  const comments = []
  function collect(token) {
    if (!token || typeof token !== 'object') return
    if (token.type === 'comment') comments.push({ start: token.offset })
    else Object.values(token).forEach(collect)
  }
  collect(tokens)
  return comments
}

function shellComments(source, variant, hasShebang) {
  const offset = createSourceIndex(source)
  const comments = []
  try {
    const ast = parseShell(source, { keepComments: true, variant })
    walk(ast, (node) => {
      if (node.type === 'Comment' && !(node.start === 0 && hasShebang)) {
        comments.push({ start: offset(node.start) })
      }
    })
  } catch (error) {
    if (error.pos) error.pos = offset(error.pos.offset)
    throw error
  }
  return comments
}

function sourceComments(path, source) {
  const extension = extname(path)
  if (javascriptExtensions.has(extension)) return javascriptComments(path, source, extension)
  if (extension === '.yaml' || extension === '.yml') return yamlComments(source)
  if (extension === '.sql') return postgresComments(source)
  const interpreter = shellInterpreter(source)
  const variant = interpreter ?? shellExtensions.get(extension)
  return variant ? shellComments(source, variant, interpreter !== undefined) : []
}

function isCandidate(path) {
  if (generatedFiles.has(path) || path.split('/').includes('generated')) return false
  const extension = extname(path)
  return extension === '' || javascriptExtensions.has(extension) || shellExtensions.has(extension) ||
    ['.yaml', '.yml', '.sql'].includes(extension)
}

function diagnostic(path, source, start, message) {
  const lines = source.slice(0, start).split(/\r\n|[\n\r\u2028\u2029]/)
  return `${path}:${lines.length}:${lines.at(-1).length + 1}: ${message}`
}

export function checkSource(path, source) {
  if (!isCandidate(path)) return []
  if (path === legacyMigration) {
    const matches = createHash('sha256').update(source).digest('hex') === legacyMigrationSha256
    return matches ? [] : [diagnostic(path, source, 0, 'historical Flyway migration checksum changed')]
  }
  try {
    return sourceComments(path, source)
      .sort((left, right) => left.start - right.start)
      .map(({ start }) => diagnostic(path, source, start, 'source comment'))
  } catch (error) {
    const start = Array.isArray(error.pos) ? error.pos[0] : error.pos ?? 0
    return [diagnostic(path, source, start, `could not scan source: ${error.message}`)]
  }
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trimEnd()
  const paths = execFileSync('git', ['ls-files', '-z', '--deduplicate'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
  for (const path of paths.filter(isCandidate)) {
    try {
      const source = readFileSync(resolve(root, path), 'utf8')
      for (const finding of checkSource(path, source)) {
        console.error(finding)
        process.exitCode = 1
      }
    } catch (error) {
      console.error(`${path}:1:1: could not read source: ${error.message}`)
      process.exitCode = 1
    }
  }
}

if (import.meta.main) main()
