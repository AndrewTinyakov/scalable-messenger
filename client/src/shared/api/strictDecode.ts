import { isRecord } from '../lib/validation'

export function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid response from server')
  return value
}

export function check(condition: boolean): asserts condition {
  if (!condition) throw new Error('Invalid response from server')
}
