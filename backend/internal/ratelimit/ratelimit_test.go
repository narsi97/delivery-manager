package ratelimit

import (
	"testing"
	"time"
)

func TestAllowBlocksAfterLimitWithinWindow(t *testing.T) {
	l := New(3, time.Minute)

	for i := 1; i <= 3; i++ {
		if !l.Allow("+919876543210") {
			t.Fatalf("attempt %d was blocked, want allowed", i)
		}
	}
	if l.Allow("+919876543210") {
		t.Fatal("attempt 4 was allowed, want blocked")
	}
}

func TestAllowIsPerKey(t *testing.T) {
	l := New(1, time.Minute)

	if !l.Allow("driver-a") {
		t.Fatal("first attempt for driver-a was blocked")
	}
	if l.Allow("driver-a") {
		t.Fatal("second attempt for driver-a was allowed")
	}
	if !l.Allow("driver-b") {
		t.Fatal("driver-b was blocked by driver-a's attempts")
	}
}

func TestWindowExpiryRestoresBudget(t *testing.T) {
	l := New(1, 20*time.Millisecond)

	if !l.Allow("k") {
		t.Fatal("first attempt blocked")
	}
	if l.Allow("k") {
		t.Fatal("second attempt within the window was allowed")
	}

	time.Sleep(30 * time.Millisecond)

	if !l.Allow("k") {
		t.Fatal("attempt after the window expired was blocked")
	}
}

// A driver who fumbles their PIN twice and then gets it right shouldn't
// spend the rest of the hour one mistake away from being locked out.
func TestResetClearsTheWindow(t *testing.T) {
	l := New(2, time.Minute)

	l.Allow("k")
	l.Allow("k")
	if l.Allow("k") {
		t.Fatal("third attempt was allowed before reset")
	}

	l.Reset("k")

	if !l.Allow("k") {
		t.Fatal("attempt after Reset was blocked")
	}
}
