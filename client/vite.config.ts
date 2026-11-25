import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { connectSources, parseTransportEndpoints } from './src/shared/config/endpoints'

const localEndpoints = {
  VITE_API_BASE_URL: 'https://api.messenger.localhost/api',
  VITE_WS_URL: 'wss://ws.messenger.localhost/ws',
}

const staticSiteHeaders = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

export default defineConfig(({ command, mode, isPreview }) => {
  if (isPreview) return { preview: { headers: staticSiteHeaders } }
  const build = command === 'build'
  const env = { ...(build ? {} : localEndpoints), ...loadEnv(mode, process.cwd(), 'VITE_') }
  const endpoints = parseTransportEndpoints(env.VITE_API_BASE_URL, env.VITE_WS_URL, {
    requireTlsOutsideLoopback: build,
  })
  const contentSecurityPolicy = [
    "default-src 'self'",
    `connect-src 'self' ${connectSources(endpoints).join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    define: {
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(endpoints.apiBaseUrl),
      'import.meta.env.VITE_WS_URL': JSON.stringify(endpoints.wsUrl),
    },
    plugins: [
      react(),
      {
        name: 'messenger-content-security-policy',
        apply: 'build',
        transformIndexHtml: () => [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy },
            injectTo: 'head-prepend',
          },
        ],
      },
    ],
  }
})
