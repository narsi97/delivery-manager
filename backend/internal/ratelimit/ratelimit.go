// Package ratelimit provides a small fixed-window counter, used to bound
// driver PIN-login attempts.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter allows at most `limit` events per `window` per key. A fixed
// window (rather than a sliding one or a token bucket) is deliberate: for
// "stop someone brute-forcing a 6-digit PIN" the worst case of a fixed
// window — up to 2x the limit across a window boundary — is irrelevant
// next to the million-wide search space it is protecting, and the
// implementation is small enough to be obviously correct.
type Limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	counts map[string]*counter
	// lastSweep bounds map growth: stale entries are dropped when a later
	// call arrives after sweepInterval, so a burst of distinct keys can't
	// leak memory indefinitely and no background goroutine is needed.
	lastSweep time.Time
}

type counter struct {
	count       int
	windowStart time.Time
}

const sweepInterval = 10 * time.Minute

func New(limit int, window time.Duration) *Limiter {
	return &Limiter{
		limit:     limit,
		window:    window,
		counts:    map[string]*counter{},
		lastSweep: time.Now(),
	}
}

// Allow records an attempt for key and reports whether it is within the
// limit.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	if now.Sub(l.lastSweep) > sweepInterval {
		for k, c := range l.counts {
			if now.Sub(c.windowStart) > l.window {
				delete(l.counts, k)
			}
		}
		l.lastSweep = now
	}

	c, ok := l.counts[key]
	if !ok || now.Sub(c.windowStart) > l.window {
		l.counts[key] = &counter{count: 1, windowStart: now}
		return true
	}

	c.count++
	return c.count <= l.limit
}

// Reset clears a key's window — called after a successful login so a
// driver who mistyped their PIN a few times isn't still near the limit
// once they get it right.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.counts, key)
}
