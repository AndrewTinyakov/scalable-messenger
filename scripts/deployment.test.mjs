import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
function temporary(action) {
  const directory = mkdtempSync(`${tmpdir()}/messenger-deployment-`)
  try { action(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}
function configure(directory, environment) {
  return spawnSync('sh', [resolve(root, 'client/configure-runtime.sh'), `${directory}/nginx.conf`, `${directory}/runtime-config.js`], {
    encoding: 'utf8', env: { ...process.env, MESSENGER_NGINX_TEMPLATE: resolve(root, 'client/nginx.conf'), ...environment },
  })
}
const production = {
  MESSENGER_PUBLIC_SCHEME: 'https',
  MESSENGER_PRODUCTION: 'true',
  MESSENGER_CLIENT_ORIGIN: 'https://chat.example.com',
  MESSENGER_API_BASE_URL: 'https://chat.example.com/api',
  MESSENGER_WS_URL: 'wss://chat.example.com/ws',
}

test('one built client accepts deployment URLs at startup and restricts CSP to their origins', () => temporary((directory) => {
  const result = configure(directory, production)
  assert.equal(result.status, 0, result.stderr)
  const runtime = readFileSync(`${directory}/runtime-config.js`, 'utf8')
  assert.ok(runtime.includes('https://chat.example.com/api'))
  assert.ok(runtime.includes('wss://chat.example.com/ws'))
  const nginx = readFileSync(`${directory}/nginx.conf`, 'utf8')
  assert.ok(nginx.includes("connect-src 'self' https://chat.example.com wss://chat.example.com;"))
  assert.ok(!nginx.includes('__MESSENGER_'))
}))

test('runtime rejects mixed content, insecure production and mismatched origins', () => temporary((directory) => {
  for (const invalid of [
    { MESSENGER_WS_URL: 'ws://chat.example.com/ws' },
    { MESSENGER_API_BASE_URL: 'http://chat.example.com/api', MESSENGER_WS_URL: 'ws://chat.example.com/ws' },
    { MESSENGER_CLIENT_ORIGIN: 'https://chat.example.com/' },
    { MESSENGER_WS_URL: 'wss://other.example.com/ws' },
    { MESSENGER_API_BASE_URL: 'https://user:password@chat.example.com/api' },
    { MESSENGER_API_BASE_URL: 'https://chat.example.com/api?token=x' },
  ]) assert.notEqual(configure(directory, { ...production, ...invalid }).status, 0)
}))

test('development secrets persist across runs, preserve existing values and use restricted files', () => temporary((directory) => {
  const original = `WS_TICKET_SECRET=${'a'.repeat(64)}\nMESSENGER_PORT=18880\n`
  writeFileSync(`${directory}/.env`, original)
  const prepare = () => spawnSync(process.execPath, [resolve(root, 'scripts/prepare-dev-env.mjs')], { cwd: directory, encoding: 'utf8' })
  const result = prepare()
  assert.equal(result.status, 0, result.stderr)
  const env = readFileSync(`${directory}/.env`, 'utf8')
  assert.ok(env.startsWith(original))
  const values = Object.fromEntries(env.trim().split('\n').map((line) => line.split('=')))
  assert.match(values.REDIS_PASSWORD, /^[a-f0-9]{64}$/)
  assert.notEqual(values.POSTGRES_API_PASSWORD, values.POSTGRES_COMMAND_PASSWORD)
  assert.equal(readFileSync(`${directory}/.local/secrets/metrics-password`, 'utf8').trim(), values.METRICS_PASSWORD)
  assert.equal(statSync(`${directory}/.env`).mode & 0o777, 0o600)
  assert.equal(statSync(`${directory}/.local/secrets/metrics-password`).mode & 0o777, 0o640)
  assert.equal(prepare().status, 0)
  assert.equal(readFileSync(`${directory}/.env`, 'utf8'), env)
}))
