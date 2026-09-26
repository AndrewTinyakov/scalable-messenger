package apiclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSessionUsesBearerAndDecodesIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.Header.Get("Authorization"), "Bearer token"; got != want {
			t.Errorf("authorization = %q, want %q", got, want)
		}
		_, _ = w.Write([]byte(`{"userId":"u1","username":"alice","deviceId":"d1"}`))
	}))
	defer server.Close()
	client, err := New(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	session, err := client.Session(context.Background(), "token")
	if err != nil {
		t.Fatal(err)
	}
	if session.UserID != "u1" || session.DeviceID != "d1" {
		t.Fatalf("session = %+v", session)
	}
}

func TestAuthorizeRejectsForbidden(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	defer server.Close()
	client, err := New(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Authorize(context.Background(), "token", "conversation")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error = %v, want ErrUnauthorized", err)
	}
}
