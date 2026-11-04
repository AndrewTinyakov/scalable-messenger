const PALETTE_SIZE = 8

export function colorIndex(seed: string): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1)
    hash = (hash * 31 + seed.charCodeAt(index)) | 0
  return Math.abs(hash) % PALETTE_SIZE
}
