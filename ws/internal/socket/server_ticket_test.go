package socket

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTicketProtocol(t *testing.T) {
	for _, tc := range []struct {
		name, header, want string
	}{
		{"ticket", "messenger, messenger-ticket.header.payload.signature", "header.payload.signature"},
		{"missing static protocol", "messenger-ticket.header.payload.signature", ""},
		{"missing ticket", "messenger", ""},
		{"duplicate ticket", "messenger, messenger-ticket.one, messenger-ticket.two", ""},
		{"oversized ticket", "messenger, messenger-ticket." + strings.Repeat("a", 4097), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/ws", nil)
			r.Header.Set("Sec-WebSocket-Protocol", tc.header)
			if got := ticketProtocol(r); got != tc.want {
				t.Fatalf("ticketProtocol() = %q, want %q", got, tc.want)
			}
		})
	}
}
