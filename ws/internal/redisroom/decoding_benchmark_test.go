package redisroom

import "testing"

func BenchmarkDecodeLive(b *testing.B) {
	const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	const room = "user:" + id
	const payload = `{"epoch":"epoch","streamId":"3-0","previousStreamId":"2-0","event":{"type":"chat_created","version":1,"eventId":"` + id + `","room":"` + room + `","chatId":"` + id + `"}}`
	b.ReportAllocs()
	for b.Loop() {
		if _, err := decodeLive(room, payload); err != nil {
			b.Fatal(err)
		}
	}
}
