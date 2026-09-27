import { describe, expect, it } from 'vitest'
import { reconnectDelay } from './reconnect'

describe('WebSocket reconnect delay', () => {
  it('spreads early attempts and caps later attempts at thirty seconds', () => {
    expect(reconnectDelay(1, () => 0)).toBe(500)
    expect(reconnectDelay(1, () => 0.999)).toBe(999)
    expect(reconnectDelay(2, () => 0)).toBe(1000)
    expect(reconnectDelay(6, () => 0)).toBe(15000)
    expect(reconnectDelay(100, () => 0.999)).toBeLessThan(30000)
  })
})
