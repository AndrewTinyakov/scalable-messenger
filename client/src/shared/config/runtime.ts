interface RuntimeConfig {
  apiBaseUrl: string
  wsUrl: string
}

declare global {
  interface Window {
    __MESSENGER_CONFIG__?: RuntimeConfig
  }
}

function loadRuntimeConfig(): RuntimeConfig {
  const browser = typeof window === 'undefined' ? undefined : window
  const configured = browser?.__MESSENGER_CONFIG__
  if (import.meta.env.PROD && !configured) {
    throw new Error('Missing Messenger runtime configuration')
  }
  const api = new URL(
    configured?.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8081/api',
  )
  const ws = new URL(configured?.wsUrl ?? import.meta.env.VITE_WS_URL ?? 'ws://localhost:8082/ws')
  if (
    !['http:', 'https:'].includes(api.protocol) ||
    !['ws:', 'wss:'].includes(ws.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    ws.username ||
    ws.password ||
    ws.search ||
    ws.hash ||
    (api.protocol === 'https:') !== (ws.protocol === 'wss:') ||
    (browser?.location.protocol === 'https:' && api.protocol !== 'https:')
  ) {
    throw new Error('Invalid Messenger transport configuration')
  }
  return { apiBaseUrl: api.href.replace(/\/$/, ''), wsUrl: ws.href }
}

export const runtimeConfig = loadRuntimeConfig()
