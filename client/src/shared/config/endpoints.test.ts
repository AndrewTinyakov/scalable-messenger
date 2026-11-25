import { describe, expect, it } from 'vitest'
import { connectSources, parseTransportEndpoints } from './endpoints'

describe('transport endpoints', () => {
  it('accepts separate API and WebSocket hosts and derives their exact connect sources', () => {
    const endpoints = parseTransportEndpoints(
      'https://api.example.com/api/',
      'wss://ws.example.com/ws',
      { requireTlsOutsideLoopback: true },
    )
    expect(endpoints).toEqual({
      apiBaseUrl: 'https://api.example.com/api',
      wsUrl: 'wss://ws.example.com/ws',
    })
    expect(connectSources(endpoints)).toEqual(['https://api.example.com', 'wss://ws.example.com'])
  })

  it('requires both endpoints explicitly', () => {
    expect(() => parseTransportEndpoints(undefined, 'wss://ws.example.com/ws')).toThrow(
      'Set VITE_API_BASE_URL and VITE_WS_URL',
    )
    expect(() => parseTransportEndpoints('https://api.example.com/api', '')).toThrow(
      'Set VITE_API_BASE_URL and VITE_WS_URL',
    )
  })

  it('rejects mixed transport security, credentials, queries and fragments', () => {
    for (const [api, ws] of [
      ['https://api.example.com/api', 'ws://ws.example.com/ws'],
      ['http://api.example.com/api', 'wss://ws.example.com/ws'],
      ['https://user:password@api.example.com/api', 'wss://ws.example.com/ws'],
      ['https://api.example.com/api?token=x', 'wss://ws.example.com/ws'],
      ['https://api.example.com/api', 'wss://ws.example.com/ws#x'],
      ['ftp://api.example.com/api', 'wss://ws.example.com/ws'],
      ['not a url', 'wss://ws.example.com/ws'],
    ]) {
      expect(() => parseTransportEndpoints(api, ws)).toThrow(
        'Invalid Messenger transport configuration',
      )
    }
  })

  it.each(['?', '#'])('rejects either endpoint with an empty %s delimiter', (delimiter) => {
    const api = 'https://api.example.com/api'
    const ws = 'wss://ws.example.com/ws'
    expect(() => parseTransportEndpoints(api + delimiter, ws)).toThrow(
      'Invalid Messenger transport configuration',
    )
    expect(() => parseTransportEndpoints(api, ws + delimiter)).toThrow(
      'Invalid Messenger transport configuration',
    )
  })

  it('allows plain HTTP for builds only when both endpoints are loopback', () => {
    const options = { requireTlsOutsideLoopback: true }
    expect(
      parseTransportEndpoints('http://localhost:8081/api', 'ws://127.0.0.1:8082/ws', options),
    ).toEqual({ apiBaseUrl: 'http://localhost:8081/api', wsUrl: 'ws://127.0.0.1:8082/ws' })
    expect(() =>
      parseTransportEndpoints('http://api.example.com/api', 'ws://localhost:8082/ws', options),
    ).toThrow('Non-loopback Messenger endpoints require HTTPS and WSS')
  })
})
