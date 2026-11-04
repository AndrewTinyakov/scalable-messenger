package ticket

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"messenger/ws/internal/messagecodec"
)

var ErrInvalid = errors.New("invalid WS ticket")

type Identity struct {
	UserID    string
	DeviceID  string
	SessionID string
	ExpiresAt time.Time
}
type claims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	DeviceID  string `json:"deviceId"`
	SessionID string `json:"sid"`
	ExpiresAt int64  `json:"exp"`
}

func Verify(raw string, secret []byte, now time.Time) (Identity, error) {
	var identity Identity
	if len(secret) < 32 || len(raw) > 4096 {
		return identity, ErrInvalid
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return identity, ErrInvalid
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return identity, ErrInvalid
	}
	fields, err := messagecodec.Decode[struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}](header)
	if err != nil || fields.Algorithm != "HS256" || fields.Type != "JWT" {
		return identity, ErrInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return identity, ErrInvalid
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(mac.Sum(nil), signature) {
		return identity, ErrInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return identity, ErrInvalid
	}
	value, err := messagecodec.Decode[claims](payload)
	if err != nil || value.Issuer != "messenger-api" || value.Audience != "messenger-ws" || value.Subject == "" || value.DeviceID == "" || !ValidSessionID(value.SessionID) || value.ExpiresAt <= now.Unix()+5 {
		return identity, ErrInvalid
	}
	return Identity{UserID: value.Subject, DeviceID: value.DeviceID, SessionID: value.SessionID, ExpiresAt: time.Unix(value.ExpiresAt, 0)}, nil
}

func ValidSessionID(id string) bool {
	if len(id) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(id)
	return err == nil && hex.EncodeToString(decoded) == id
}
