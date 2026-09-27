export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 5)
  const ceiling = Math.min(1000 * 2 ** exponent, 30000)
  return Math.floor(ceiling / 2 + random() * ceiling / 2)
}
