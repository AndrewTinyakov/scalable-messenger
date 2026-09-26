const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function createUlid(): string {
  let time = Date.now()
  let result = ''
  for (let index = 0; index < 10; index += 1) {
    result = alphabet[time % 32] + result
    time = Math.floor(time / 32)
  }
  const random = crypto.getRandomValues(new Uint8Array(16))
  for (let index = 0; index < 16; index += 1) result += alphabet[random[index] % 32]
  return result
}
