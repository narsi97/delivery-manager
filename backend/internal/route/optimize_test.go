package route

import (
	"math"
	"testing"
)

// A degree of latitude is ~111km everywhere, so laying test points out on
// a single meridian makes expected distances easy to reason about by hand.
func TestDistanceMetersKnownSeparation(t *testing.T) {
	got := DistanceMeters(0, 0, 1, 0)
	const wantApprox = 111195.0
	if math.Abs(got-wantApprox) > 500 {
		t.Fatalf("DistanceMeters(0,0,1,0) = %.1f, want ~%.1f", got, wantApprox)
	}

	if d := DistanceMeters(12.9716, 77.5946, 12.9716, 77.5946); d != 0 {
		t.Fatalf("distance from a point to itself = %v, want 0", d)
	}
}

func TestOptimizeEmptyAndSingle(t *testing.T) {
	start := Point{ID: "depot", Lat: 12.97, Lng: 77.59}

	ordered, dist := Optimize(start, nil)
	if len(ordered) != 0 || dist != 0 {
		t.Fatalf("Optimize with no stops = (%v, %v), want (empty, 0)", ordered, dist)
	}

	only := Point{ID: "a", Lat: 12.98, Lng: 77.59}
	ordered, dist = Optimize(start, []Point{only})
	if len(ordered) != 1 || ordered[0].ID != "a" {
		t.Fatalf("Optimize with one stop = %v, want [a]", ordered)
	}
	if want := DistanceMeters(start.Lat, start.Lng, only.Lat, only.Lng); math.Abs(dist-want) > 1 {
		t.Fatalf("single-stop distance = %.1f, want %.1f", dist, want)
	}
}

// Stops handed over shuffled but lying on a straight line away from the
// depot have exactly one sensible order: nearest first. This is the
// everyday case — a street of houses done in order rather than by
// bouncing up and down it.
func TestOptimizeOrdersStopsAlongALine(t *testing.T) {
	start := Point{ID: "depot", Lat: 0, Lng: 0}
	stops := []Point{
		{ID: "d", Lat: 0.04, Lng: 0},
		{ID: "b", Lat: 0.02, Lng: 0},
		{ID: "e", Lat: 0.05, Lng: 0},
		{ID: "a", Lat: 0.01, Lng: 0},
		{ID: "c", Lat: 0.03, Lng: 0},
	}

	ordered, dist := Optimize(start, stops)

	want := []string{"a", "b", "c", "d", "e"}
	if len(ordered) != len(want) {
		t.Fatalf("got %d stops, want %d", len(ordered), len(want))
	}
	for i, id := range want {
		if ordered[i].ID != id {
			t.Fatalf("stop %d = %q, want %q (full order %v)", i, ordered[i].ID, id, ids(ordered))
		}
	}

	// Walking the line once should cost about the distance to the far
	// end — anything materially more means the route doubled back.
	straightThrough := DistanceMeters(0, 0, 0.05, 0)
	if math.Abs(dist-straightThrough) > 1 {
		t.Fatalf("route length = %.1f, want ~%.1f (no doubling back)", dist, straightThrough)
	}
}

// Optimize must never drop, duplicate, or invent a stop: every delivery
// handed in has to come back out exactly once, or a customer silently
// misses their milk.
func TestOptimizePreservesEveryStop(t *testing.T) {
	start := Point{ID: "depot", Lat: 12.9716, Lng: 77.5946}
	stops := []Point{
		{ID: "s1", Lat: 12.9750, Lng: 77.6000},
		{ID: "s2", Lat: 12.9600, Lng: 77.5800},
		{ID: "s3", Lat: 12.9800, Lng: 77.5900},
		{ID: "s4", Lat: 12.9650, Lng: 77.6100},
		{ID: "s5", Lat: 12.9720, Lng: 77.5950},
		{ID: "s6", Lat: 12.9900, Lng: 77.6200},
	}

	ordered, _ := Optimize(start, stops)

	if len(ordered) != len(stops) {
		t.Fatalf("got %d stops back, want %d", len(ordered), len(stops))
	}
	seen := map[string]int{}
	for _, p := range ordered {
		seen[p.ID]++
	}
	for _, p := range stops {
		if seen[p.ID] != 1 {
			t.Fatalf("stop %q appears %d times in the route, want exactly 1", p.ID, seen[p.ID])
		}
	}
}

// Co-located pins (two customers in one apartment block) are common, and
// a rebuild that reshuffles the list would make the driver lose their
// place. Same input must always give the same output.
func TestOptimizeIsDeterministic(t *testing.T) {
	start := Point{ID: "depot", Lat: 12.9716, Lng: 77.5946}
	stops := []Point{
		{ID: "a", Lat: 12.9750, Lng: 77.6000},
		{ID: "b", Lat: 12.9750, Lng: 77.6000},
		{ID: "c", Lat: 12.9600, Lng: 77.5800},
		{ID: "d", Lat: 12.9600, Lng: 77.5800},
		{ID: "e", Lat: 12.9800, Lng: 77.5900},
	}

	first, firstDist := Optimize(start, stops)
	for i := 0; i < 5; i++ {
		again, againDist := Optimize(start, stops)
		if againDist != firstDist {
			t.Fatalf("run %d distance = %v, want %v", i, againDist, firstDist)
		}
		for j := range first {
			if first[j].ID != again[j].ID {
				t.Fatalf("run %d order = %v, want %v", i, ids(again), ids(first))
			}
		}
	}
}

// Optimize must not mutate the caller's slice — the handler still needs
// its original daily-order list after building a route.
func TestOptimizeDoesNotMutateInput(t *testing.T) {
	start := Point{ID: "depot", Lat: 0, Lng: 0}
	stops := []Point{
		{ID: "far", Lat: 0.05, Lng: 0},
		{ID: "near", Lat: 0.01, Lng: 0},
		{ID: "mid", Lat: 0.03, Lng: 0},
		{ID: "further", Lat: 0.07, Lng: 0},
	}
	before := ids(stops)

	Optimize(start, stops)

	if after := ids(stops); !equal(before, after) {
		t.Fatalf("input slice was reordered: %v -> %v", before, after)
	}
}

// The specific thing 2-opt is there to fix: nearest-neighbour strands a
// far pin and produces a crossed path. Whatever order comes out, it must
// be no worse than the greedy-only ordering.
func TestOptimizeNeverWorseThanNearestNeighbour(t *testing.T) {
	start := Point{ID: "depot", Lat: 0, Lng: 0}
	stops := []Point{
		{ID: "a", Lat: 0.010, Lng: 0.000},
		{ID: "b", Lat: 0.000, Lng: 0.010},
		{ID: "c", Lat: 0.010, Lng: 0.010},
		{ID: "d", Lat: 0.020, Lng: 0.000},
		{ID: "e", Lat: 0.000, Lng: 0.020},
		{ID: "f", Lat: 0.020, Lng: 0.020},
		{ID: "g", Lat: 0.030, Lng: 0.010},
	}

	greedy := nearestNeighbour(start, stops)
	greedyLen := pathLength(start, greedy, nil)

	_, optimizedLen := Optimize(start, stops)

	if optimizedLen > greedyLen+1e-6 {
		t.Fatalf("2-opt made the route longer: %.1f vs greedy %.1f", optimizedLen, greedyLen)
	}
}

func ids(points []Point) []string {
	out := make([]string, len(points))
	for i, p := range points {
		out[i] = p.ID
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
