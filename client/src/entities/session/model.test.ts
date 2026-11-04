import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceId, discardLegacySession } from './model'

afterEach(() => vi.unstubAllGlobals())

describe('session storage', () => {
  it('removes legacy credentials without writing session data', () => {
    const removeItem = vi.fn()
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { removeItem, setItem })
    discardLegacySession()
    expect(removeItem).toHaveBeenCalledExactlyOnceWith('messenger.session.v1')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('retains an existing valid device identifier', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const getItem = vi.fn(() => id)
    vi.stubGlobal('localStorage', { getItem })
    expect(deviceId()).toBe(id)
    expect(getItem).toHaveBeenCalledWith('relay.device.v1')
  })

  it('keeps authentication usable when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Storage blocked')
      },
      setItem: () => {
        throw new Error('Storage blocked')
      },
      removeItem: () => {
        throw new Error('Storage blocked')
      },
    })
    expect(() => discardLegacySession()).not.toThrow()
    expect(deviceId()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(deviceId()).toBe(deviceId())
  })
})
