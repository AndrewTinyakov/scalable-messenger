package presence

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"messenger/ws/internal/grpcauth"
)

const lastSeenBatch = 1000

// lastSeen sends durable "seen at" times in batches, at most once per user
// per minimum gap.
type lastSeen struct {
	recorder LastSeenRecorder
	config   Config
	logger   *slog.Logger
	mu       sync.Mutex
	pending  map[string]time.Time
	sent     map[string]time.Time
}

func newLastSeen(recorder LastSeenRecorder, config Config, logger *slog.Logger) *lastSeen {
	return &lastSeen{recorder: recorder, config: config, logger: logger, pending: make(map[string]time.Time), sent: make(map[string]time.Time)}
}

func (l *lastSeen) record(userID string, at time.Time) {
	l.mu.Lock()
	if at.After(l.pending[userID]) {
		l.pending[userID] = at
	}
	l.mu.Unlock()
}

func (l *lastSeen) run(ctx context.Context) {
	ticker := time.NewTicker(l.config.LastSeenFlush)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), l.config.Timeout)
			l.flush(flushCtx, time.Now().Add(l.config.LastSeenMinGap))
			cancel()
			return
		case now := <-ticker.C:
			l.flush(ctx, now)
		}
	}
}

func (l *lastSeen) flush(ctx context.Context, now time.Time) {
	l.mu.Lock()
	batch := make([]grpcauth.LastSeen, 0, min(len(l.pending), lastSeenBatch))
	for userID, at := range l.pending {
		if len(batch) == lastSeenBatch {
			break
		}
		if now.Sub(l.sent[userID]) < l.config.LastSeenMinGap {
			continue
		}
		batch = append(batch, grpcauth.LastSeen{UserID: userID, SeenAt: at})
		delete(l.pending, userID)
		l.sent[userID] = now
	}
	for userID, at := range l.sent {
		if now.Sub(at) >= l.config.LastSeenMinGap {
			delete(l.sent, userID)
		}
	}
	l.mu.Unlock()
	if len(batch) == 0 {
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, l.config.Timeout)
	defer cancel()
	if err := l.recorder.RecordLastSeen(callCtx, batch); err != nil {
		l.logger.Warn("record last seen", "error", err, "users", len(batch))
		l.mu.Lock()
		for _, entry := range batch {
			if entry.SeenAt.After(l.pending[entry.UserID]) {
				l.pending[entry.UserID] = entry.SeenAt
			}
			delete(l.sent, entry.UserID)
		}
		l.mu.Unlock()
	}
}
