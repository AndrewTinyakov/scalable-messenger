package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (work *run) register(ctx context.Context, body any, target any) (string, error) {
	response, err := work.request(ctx, "", http.MethodPost, "/auth/register", body)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target); err != nil {
		return "", err
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == "__Host-messenger_session" || cookie.Name == "messenger_session" {
			return cookie.Name + "=" + cookie.Value, nil
		}
	}
	return "", errors.New("registration did not set a session cookie")
}

func (work *run) api(ctx context.Context, cookie, method, path string, body, target any) error {
	response, err := work.request(ctx, cookie, method, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if target == nil {
		_, err := io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
		return err
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target)
}

func (work *run) request(ctx context.Context, cookie, method, path string, body any) (*http.Response, error) {
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	for attempt := 0; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(work.opts.apiURL, "/")+"/v1"+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if method != http.MethodGet {
			request.Header.Set("Origin", work.opts.origin)
			request.Header.Set("X-Messenger-CSRF", "1")
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response, err := work.http.Do(request)
		if err != nil {
			return nil, err
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return response, nil
		}
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		if response.StatusCode != http.StatusTooManyRequests || !wait(ctx, time.Duration(min(attempt+1, 5))*250*time.Millisecond) {
			return nil, fmt.Errorf("%s %s returned HTTP %d", method, path, response.StatusCode)
		}
	}
}
