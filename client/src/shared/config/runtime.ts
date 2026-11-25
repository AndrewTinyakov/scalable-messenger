import { parseTransportEndpoints, type TransportEndpoints } from './endpoints'

function loadRuntimeConfig(): TransportEndpoints {
  const endpoints = parseTransportEndpoints(
    import.meta.env.VITE_API_BASE_URL,
    import.meta.env.VITE_WS_URL,
  )
  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    !endpoints.apiBaseUrl.startsWith('https:')
  ) {
    throw new Error('Invalid Messenger transport configuration')
  }
  return endpoints
}

export const runtimeConfig = loadRuntimeConfig()
