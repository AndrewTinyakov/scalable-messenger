import { readFileSync } from 'node:fs'

function origin(value, protocols) {
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid Messenger transport URL')
  }
  return url.origin
}

const api = origin(process.env.VITE_API_BASE_URL ?? 'http://localhost:8081/api', [
  'http:',
  'https:',
])
const ws = origin(process.env.VITE_WS_URL ?? 'ws://localhost:8082/ws', ['ws:', 'wss:'])
const template = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8')
process.stdout.write(
  template.replaceAll('__MESSENGER_API_ORIGIN__', api).replaceAll('__MESSENGER_WS_ORIGIN__', ws),
)
