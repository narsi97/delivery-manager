package httpapi

import (
	"strings"
	"testing"
)

// A written Indian address is a chain of decreasing precision. The
// landmark in the middle of it is how somebody directs a driver and is
// not a thing any gazetteer holds, so it comes out; what is left is
// tried from the most specific wording down to the town.
func TestGeocodeCandidatesShedTheLandmarkThenTheDetail(t *testing.T) {
	got := geocodeCandidates("Shiva Balaji Hoteal, Shivaji Nagar, Beside S.B.I Bank, Nalgonda")

	for _, candidate := range got {
		if strings.Contains(strings.ToLower(candidate), "beside") {
			t.Fatalf("candidate %q still carries the landmark", candidate)
		}
	}
	want := []string{
		"Shiva Balaji Hoteal, Shivaji Nagar, Nalgonda",
		"Shivaji Nagar, Nalgonda",
		"Nalgonda",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d candidates %v, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("candidate %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// Three at most: each one is a request to a service that asks for a
// second between them, and somebody is waiting for a map to move.
func TestGeocodeCandidatesAreCapped(t *testing.T) {
	got := geocodeCandidates("A, B, C, D, E, F, G")
	if len(got) > 3 {
		t.Errorf("got %d candidates, want at most 3", len(got))
	}
}

// An address that is nothing but a landmark still gets tried as written
// rather than becoming an empty query.
func TestGeocodeCandidatesKeepAPureLandmark(t *testing.T) {
	got := geocodeCandidates("Opposite the bus stand")
	if len(got) != 1 || got[0] != "Opposite the bus stand" {
		t.Errorf("candidates = %v, want the address unchanged", got)
	}
}
