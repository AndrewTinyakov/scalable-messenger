package ticket

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"
)

func signedTicket(secret []byte, payload string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body := base64.RawURLEncoding.EncodeToString([]byte(payload))
	signed := header + "." + body
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerify(t *testing.T) {
	secret := []byte("test-ws-ticket-secret-long-enough-for-hmac-2026")
	now := time.Unix(1_800_000_000, 0)
	valid := signedTicket(secret, `{"iss":"messenger-api","aud":"messenger-ws","sub":"user","deviceId":"device","sid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","exp":1800003600}`)
	got, err := Verify(valid, secret, now)
	if err != nil || got.UserID != "user" || got.DeviceID != "device" || got.SessionID != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("Verify(valid) = %+v, %v", got, err)
	}
	cases := []struct {
		name, raw string
		at        time.Time
	}{
		{"duplicate claim", signedTicket(secret, `{"iss":"messenger-api","aud":"messenger-ws","sub":"first","sub":"user","deviceId":"device","sid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","exp":1800003600}`), now},
		{"case alias", signedTicket(secret, `{"iss":"messenger-api","aud":"messenger-ws","SUB":"user","deviceId":"device","sid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","exp":1800003600}`), now},
		{"unknown claim", signedTicket(secret, `{"iss":"messenger-api","aud":"messenger-ws","sub":"user","deviceId":"device","sid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","exp":1800003600,"extra":true}`), now},
		{"expired", valid, now.Add(time.Hour)},
		{"tampered", valid[:len(valid)-1] + "x", now},
		{"wrong audience", signedTicket(secret, `{"iss":"messenger-api","aud":"other","sub":"user","deviceId":"device","exp":1800003600}`), now},
		{"missing session", signedTicket(secret, `{"iss":"messenger-api","aud":"messenger-ws","sub":"user","deviceId":"device","exp":1800003600}`), now},
		{"uppercase session", signedTicket(secret, `{"iss":"messenger-api","aud":"messenger-ws","sub":"user","deviceId":"device","sid":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","exp":1800003600}`), now},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Verify(tc.raw, secret, tc.at); err == nil {
				t.Fatal("Verify() accepted invalid ticket")
			}
		})
	}
}
