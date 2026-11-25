export interface TransportEndpoints {
  apiBaseUrl: string
  wsUrl: string
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopback(url: URL): boolean {
  return loopbackHosts.has(url.hostname) || url.hostname.endsWith('.localhost')
}

function hasExtras(url: URL): boolean {
  return Boolean(url.username || url.password || /[?#]/.test(url.href))
}

export function parseTransportEndpoints(
  apiBaseUrl: string | undefined,
  wsUrl: string | undefined,
  { requireTlsOutsideLoopback = false }: { requireTlsOutsideLoopback?: boolean } = {},
): TransportEndpoints {
  if (!apiBaseUrl || !wsUrl) {
    throw new Error('Set VITE_API_BASE_URL and VITE_WS_URL')
  }
  let api: URL
  let ws: URL
  try {
    api = new URL(apiBaseUrl)
    ws = new URL(wsUrl)
  } catch {
    throw new Error('Invalid Messenger transport configuration')
  }
  if (
    !['http:', 'https:'].includes(api.protocol) ||
    !['ws:', 'wss:'].includes(ws.protocol) ||
    hasExtras(api) ||
    hasExtras(ws) ||
    (api.protocol === 'https:') !== (ws.protocol === 'wss:')
  ) {
    throw new Error('Invalid Messenger transport configuration')
  }
  if (
    requireTlsOutsideLoopback &&
    (api.protocol !== 'https:' || ws.protocol !== 'wss:') &&
    !(isLoopback(api) && isLoopback(ws))
  ) {
    throw new Error('Non-loopback Messenger endpoints require HTTPS and WSS')
  }
  return { apiBaseUrl: api.href.replace(/\/$/, ''), wsUrl: ws.href }
}

export function connectSources({ apiBaseUrl, wsUrl }: TransportEndpoints): string[] {
  return [new URL(apiBaseUrl).origin, new URL(wsUrl).origin]
}
