import type { components } from '../../shared/api/generated/schema'
import { createUlid } from '../../shared/lib/id'

export type User = components['schemas']['UserResponse']

export type Session = components['schemas']['AuthResponse']

export type ActiveSession = components['schemas']['ActiveSessionResponse']

const deviceKey = 'relay.device.v1'
let fallbackDeviceId: string | undefined

export function deviceId(): string {
  try {
    const existing = localStorage.getItem(deviceKey)
    if (existing && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(existing)) {
      fallbackDeviceId = existing
      return existing
    }
  } catch {}
  const created = fallbackDeviceId ?? createUlid()
  fallbackDeviceId = created
  try {
    localStorage.setItem(deviceKey, created)
  } catch {}
  return created
}

export function discardLegacySession(): void {
  try {
    localStorage.removeItem('messenger.session.v1')
  } catch {}
}
