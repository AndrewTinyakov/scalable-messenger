export class TestSocket {
  static OPEN = 1
  readyState = 0
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []

  open() {
    this.readyState = 1
    this.onopen?.()
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1006 })
  }
  send(data: string) {
    this.sent.push(data)
  }
  event(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}
