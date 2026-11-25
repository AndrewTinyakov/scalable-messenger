import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
function temporary(action) {
  const directory = mkdtempSync(`${tmpdir()}/messenger-deployment-`)
  try { action(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}
function buildClient(directory, environment) {
  const env = { ...process.env, VITE_API_BASE_URL: '', VITE_WS_URL: '', ...environment }
  return spawnSync(process.execPath, [resolve(root, 'client/node_modules/vite/bin/vite.js'), 'build', '--outDir', directory, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: resolve(root, 'client'), encoding: 'utf8', env,
  })
}
function configureEdge(directory, environment) {
  return spawnSync('sh', [resolve(root, 'deploy/nginx/configure-edge.sh')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, MESSENGER_NGINX_CONF_DIR: directory, ...environment },
  })
}
const endpoints = {
  VITE_API_BASE_URL: 'https://api.example.com/api',
  VITE_WS_URL: 'wss://ws.example.com/ws',
}
const edge = {
  MESSENGER_PUBLIC_SCHEME: 'https',
  MESSENGER_CLIENT_ORIGIN: 'https://example.com',
  MESSENGER_TRUSTED_PROXY_CIDRS: '192.0.2.0/24 2001:db8:1234::/64',
}

test('the static build targets explicit API and WebSocket hosts and restricts CSP to them', () => temporary((directory) => {
  const result = buildClient(directory, endpoints)
  assert.equal(result.status, 0, result.stderr)
  const html = readFileSync(`${directory}/index.html`, 'utf8')
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; connect-src &#39;self&#39; https:\/\/api\.example\.com wss:\/\/ws\.example\.com;/)
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'))
  assert.ok(!existsSync(`${directory}/runtime-config.js`))
  const bundle = readdirSync(`${directory}/assets`).filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(`${directory}/assets/${name}`, 'utf8')).join('\n')
  assert.ok(bundle.includes('https://api.example.com/api'))
  assert.ok(bundle.includes('wss://ws.example.com/ws'))
  assert.ok(!bundle.includes('__MESSENGER_CONFIG__'))
}))

test('the static build rejects missing, mixed and insecure public endpoints', () => temporary((directory) => {
  for (const invalid of [
    { VITE_API_BASE_URL: '' },
    { VITE_WS_URL: '' },
    { VITE_WS_URL: 'ws://ws.example.com/ws' },
    { VITE_API_BASE_URL: 'http://api.example.com/api', VITE_WS_URL: 'ws://ws.example.com/ws' },
    { VITE_API_BASE_URL: 'https://user:password@api.example.com/api' },
    { VITE_API_BASE_URL: 'https://api.example.com/api?token=x' },
  ]) assert.notEqual(buildClient(directory, { ...endpoints, ...invalid }).status, 0, JSON.stringify(invalid))
}))

test('public proxies trust only configured load balancers and forward the public scheme', () => temporary((directory) => {
  const result = configureEdge(directory, edge)
  assert.equal(result.status, 0, result.stderr)
  const trusted = readFileSync(`${directory}/trusted-proxies.inc`, 'utf8')
  assert.deepEqual(trusted.match(/set_real_ip_from [^;]+;/g), ['set_real_ip_from 192.0.2.0/24;', 'set_real_ip_from 2001:db8:1234::/64;'])
  const proxy = readFileSync(`${directory}/proxy-headers.inc`, 'utf8')
  assert.ok(proxy.includes('proxy_set_header X-Forwarded-For $remote_addr;'))
  assert.ok(proxy.includes('proxy_set_header X-Forwarded-Proto https;'))
  assert.ok(proxy.includes('proxy_set_header Forwarded "";'))
  assert.ok(readFileSync(`${directory}/edge-headers.inc`, 'utf8').includes('Strict-Transport-Security "max-age=31536000"'))
  const origin = readFileSync(`${directory}/client-origin.inc`, 'utf8')
  assert.ok(origin.includes('"https://example.com" "https://example.com";'))
  assert.equal(configureEdge(directory, { ...edge, MESSENGER_TRUSTED_PROXY_CIDRS: '' }).status, 0)
  assert.ok(!readFileSync(`${directory}/trusted-proxies.inc`, 'utf8').includes('set_real_ip_from'))
}))

test('public proxies reject broad trust ranges and inexact or insecure browser origins', () => temporary((directory) => {
  for (const invalid of [
    { MESSENGER_TRUSTED_PROXY_CIDRS: '0.0.0.0/0' },
    { MESSENGER_TRUSTED_PROXY_CIDRS: '2001:db8::/16' },
    { MESSENGER_TRUSTED_PROXY_CIDRS: 'lb.example.com' },
    { MESSENGER_CLIENT_ORIGIN: 'http://example.com' },
    { MESSENGER_CLIENT_ORIGIN: 'https://example.com/' },
    { MESSENGER_CLIENT_ORIGIN: 'https://Example.com' },
    { MESSENGER_CLIENT_ORIGIN: 'example.com' },
    { MESSENGER_PUBLIC_SCHEME: 'ftp' },
  ]) assert.notEqual(configureEdge(directory, { ...edge, ...invalid }).status, 0, JSON.stringify(invalid))
  assert.equal(configureEdge(directory, { MESSENGER_CLIENT_ORIGIN: 'https://messenger.localhost' }).status, 0)
}))

test('the edge accepts bracketed IPv6 origins with or without a port and rejects unsafe authorities', () => temporary((directory) => {
  for (const origin of ['https://[::1]', 'https://[2001:db8::10]:8443', 'https://[::ffff:192.0.2.1]']) {
    const result = configureEdge(directory, { ...edge, MESSENGER_CLIENT_ORIGIN: origin })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(readFileSync(`${directory}/client-origin.inc`, 'utf8').includes(`"${origin}" "${origin}";`))
  }
  for (const origin of [
    'https://::1', 'https://[::1', 'https://[::1]]', 'https://[::1]extra',
    'https://[::1]:', 'https://[::1]:https', 'https://[::1]:8443:443',
    'https://[fe80::1%25en0]', 'https://[::1]/', 'https://[::1]?', 'https://[::1]#',
    'https://[::1]";', 'https://[::1]$host', 'https://[::1]\\', 'https://[::1]\n[::2]',
  ]) {
    assert.notEqual(configureEdge(directory, { ...edge, MESSENGER_CLIENT_ORIGIN: origin }).status, 0, origin)
  }
}))

test('development secrets persist across runs, preserve existing values and use restricted files', () => temporary((directory) => {
  const original = `WS_TICKET_SECRET=${'a'.repeat(64)}\nMESSENGER_API_PORT=18881\n`
  writeFileSync(`${directory}/.env`, original)
  const prepare = () => spawnSync(process.execPath, [resolve(root, 'scripts/prepare-dev-env.mjs')], { cwd: directory, encoding: 'utf8' })
  const result = prepare()
  assert.equal(result.status, 0, result.stderr)
  const env = readFileSync(`${directory}/.env`, 'utf8')
  assert.ok(env.startsWith(original))
  const values = Object.fromEntries(env.trim().split('\n').map((line) => line.split('=')))
  assert.match(values.REDIS_PASSWORD, /^[a-f0-9]{64}$/)
  assert.equal(values.MESSENGER_SESSION_COOKIE_SECURE, 'true')
  assert.notEqual(values.POSTGRES_API_PASSWORD, values.POSTGRES_COMMAND_PASSWORD)
  assert.equal(readFileSync(`${directory}/.local/secrets/metrics-password`, 'utf8').trim(), values.METRICS_PASSWORD)
  assert.equal(statSync(`${directory}/.env`).mode & 0o777, 0o600)
  assert.equal(statSync(`${directory}/.local/secrets/metrics-password`).mode & 0o777, 0o640)
  assert.equal(prepare().status, 0)
  assert.equal(readFileSync(`${directory}/.env`, 'utf8'), env)
}))
