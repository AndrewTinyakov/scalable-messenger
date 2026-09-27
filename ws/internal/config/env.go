package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

func stringEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
func intEnv(key string, fallback int) (int, error) {
	if v, ok := os.LookupEnv(key); ok {
		n, e := strconv.Atoi(v)
		if e != nil {
			return 0, fmt.Errorf("%s: %w", key, e)
		}
		return n, nil
	}
	return fallback, nil
}
func int64Env(key string, fallback int64) (int64, error) {
	if v, ok := os.LookupEnv(key); ok {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil {
			return 0, fmt.Errorf("%s: %w", key, e)
		}
		return n, nil
	}
	return fallback, nil
}
func durationEnv(key string, fallback time.Duration) (time.Duration, error) {
	if v, ok := os.LookupEnv(key); ok {
		n, e := time.ParseDuration(v)
		if e != nil {
			return 0, fmt.Errorf("%s: %w", key, e)
		}
		return n, nil
	}
	return fallback, nil
}
