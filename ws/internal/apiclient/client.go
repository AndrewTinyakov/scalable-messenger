package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrUnauthorized = errors.New("unauthorized")

type Session struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	DeviceID string `json:"deviceId"`
}
type Authorization struct {
	Allowed bool   `json:"allowed"`
	Room    string `json:"room"`
	Version int    `json:"version"`
}

type Client struct {
	base string
	http *http.Client
}

func New(base string, timeout time.Duration) (*Client, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("invalid API URL")
	}
	return &Client{base: strings.TrimRight(base, "/"), http: &http.Client{Timeout: timeout}}, nil
}

func (c *Client) Session(ctx context.Context, token string) (Session, error) {
	var result Session
	err := c.get(ctx, "/api/v1/auth/session", token, &result)
	if err != nil {
		return result, err
	}
	if result.UserID == "" || result.DeviceID == "" {
		return result, errors.New("session response missing identity")
	}
	return result, nil
}

func (c *Client) Authorize(ctx context.Context, token, conversationID string) (Authorization, error) {
	var result Authorization
	err := c.get(ctx, "/api/v1/conversations/"+url.PathEscape(conversationID)+"/authorization", token, &result)
	if err != nil {
		return result, err
	}
	if !result.Allowed {
		return result, ErrUnauthorized
	}
	if !strings.HasPrefix(result.Room, "group:") && !strings.HasPrefix(result.Room, "user:") {
		return result, errors.New("invalid authorized room")
	}
	return result, nil
}

func (c *Client) get(ctx context.Context, path, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("API request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
		return ErrUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4097))
	if err != nil {
		return fmt.Errorf("read API response: %w", err)
	}
	if len(body) > 4096 {
		return errors.New("API response too large")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("decode API response: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("multiple API response values")
	}
	return nil
}
