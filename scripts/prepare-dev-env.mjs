import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const envPath = '.env'
const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const values = new Map(
  original.split('\n').flatMap((line) => {
    const match = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/)
    return match ? [[match[1], match[2]]] : []
  }),
)
const passwords = [
  'WS_TICKET_SECRET',
  'POSTGRES_ADMIN_PASSWORD',
  'POSTGRES_API_PASSWORD',
  'POSTGRES_COMMAND_PASSWORD',
  'POSTGRES_PUBLISHER_PASSWORD',
  'POSTGRES_MIGRATOR_PASSWORD',
  'POSTGRES_EXPORTER_PASSWORD',
  'RABBITMQ_PASSWORD',
  'RABBITMQ_ERLANG_COOKIE',
  'REDIS_PASSWORD',
  'METRICS_PASSWORD',
  'GRAFANA_ADMIN_PASSWORD',
]
let additions = ''
for (const [key, value] of [
  ...passwords.map((key) => [key, randomBytes(32).toString('hex')]),
  ['MESSENGER_SESSION_COOKIE_SECURE', 'true'],
  ['MESSENGER_GRPC_GID', String(process.getgid())],
]) {
  if (values.has(key)) {
    if (!values.get(key)) throw new Error(`${key} is empty in .env`)
    continue
  }
  additions += `${key}=${value}\n`
  values.set(key, value)
}
if (values.get('MESSENGER_GRPC_GID') !== String(process.getgid())) {
  throw new Error('MESSENGER_GRPC_GID in .env must match id -g')
}
writeFileSync(envPath, original + (original.endsWith('\n') ? '' : '\n') + additions, { mode: 0o600 })
chmodSync(envPath, 0o600)
mkdirSync('.local/secrets', { recursive: true, mode: 0o750 })
chmodSync('.local/secrets', 0o750)
const metricsPassword = values.get('METRICS_PASSWORD')
if (!/^[A-Za-z0-9_-]{32,}$/.test(metricsPassword)) {
  throw new Error('METRICS_PASSWORD must contain at least 32 letters, digits, underscores or hyphens')
}
writeFileSync('.local/secrets/metrics-password', `${metricsPassword}\n`, { mode: 0o640 })
chmodSync('.local/secrets/metrics-password', 0o640)
