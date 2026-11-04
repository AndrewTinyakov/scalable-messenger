import { describe, expect, it } from 'vitest'
import { memoryStorage } from './chatRecovery.fixtures'
import { ReadingLocations } from './readingLocation'

describe('bounded reading locations', () => {
  it('persists only 100 small locations and restores them without message bodies', () => {
    const storage = memoryStorage()
    const locations = new ReadingLocations('locations', storage)
    for (let index = 1; index <= 101; index += 1)
      locations.remember(String(index).padStart(26, '0'), {
        messageId: String(index).padStart(26, '0'),
        sequence: String(index),
        offsetPx: -17.5,
        atLatest: false,
      })
    const restored = new ReadingLocations('locations', storage)
    expect(restored.get('00000000000000000000000001')).toBeUndefined()
    expect(restored.get('00000000000000000000000101')).toEqual({
      messageId: '00000000000000000000000101',
      sequence: '101',
      offsetPx: -17.5,
      atLatest: false,
    })
    expect(Object.keys(JSON.parse(storage.getItem('locations')!))).toHaveLength(100)
    expect(storage.getItem('locations')).not.toContain('body')
  })

  it('ignores malformed persisted values and forgets deleted locations', () => {
    const storage = memoryStorage()
    const id = '00000000000000000000000001'
    storage.setItem(
      'locations',
      JSON.stringify({
        [id]: {
          messageId: id,
          sequence: '1',
          offsetPx: 0,
          atLatest: false,
          body: 'should not persist',
        },
      }),
    )
    const locations = new ReadingLocations('locations', storage)
    expect(locations.get(id)).toBeUndefined()
    locations.remember(id, { messageId: id, sequence: '1', offsetPx: 0, atLatest: true })
    locations.forget(id)
    expect(new ReadingLocations('locations', storage).get(id)).toBeUndefined()
  })
})
