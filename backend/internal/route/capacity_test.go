package route

import (
	"fmt"
	"testing"
)

func lineOfStops(n int) []Point {
	stops := make([]Point, 0, n)
	for i := 0; i < n; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("s%d", i), Lat: 12.90 + float64(i)*0.002, Lng: 77.59})
	}
	return stops
}

// The case a real dairy described: the owner takes ten on the way
// somewhere and the full-time driver takes the rest.
func TestACappedDriverTakesNoMoreThanTheirCap(t *testing.T) {
	stops := lineOfStops(40)
	groups, leftover := PartitionCapped(stops, []Capped{{Max: 10}, {Max: 0}})

	if len(groups[0]) != 10 {
		t.Fatalf("capped driver got %d stops, want exactly 10", len(groups[0]))
	}
	if len(groups[1]) != 30 {
		t.Fatalf("uncapped driver got %d stops, want the remaining 30", len(groups[1]))
	}
	if len(leftover) != 0 {
		t.Fatalf("%d stops left over when an uncapped driver could take them", len(leftover))
	}
}

// A cap is a maximum, not a target — a friend helping with five gets
// five, not a third of the round.
func TestSmallCapsDoNotBecomeEqualShares(t *testing.T) {
	stops := lineOfStops(30)
	groups, _ := PartitionCapped(stops, []Capped{{Max: 5}, {Max: 0}})
	if len(groups[0]) != 5 {
		t.Fatalf("the helper got %d stops, want 5", len(groups[0]))
	}
}

// If the caps genuinely don't cover the day, the shortfall is visible
// rather than being forced onto someone.
func TestWorkBeyondEveryCapIsLeftOver(t *testing.T) {
	stops := lineOfStops(25)
	groups, leftover := PartitionCapped(stops, []Capped{{Max: 5}, {Max: 5}})

	placed := len(groups[0]) + len(groups[1])
	if placed != 10 {
		t.Fatalf("placed %d stops, want 10 — caps must be respected", placed)
	}
	if len(leftover) != 15 {
		t.Fatalf("%d left over, want 15", len(leftover))
	}
}

// Every stop is accounted for exactly once, however the caps fall.
func TestNoStopIsLostOrDuplicated(t *testing.T) {
	stops := lineOfStops(37)
	for _, caps := range [][]Capped{
		{{Max: 10}, {Max: 0}},
		{{Max: 5}, {Max: 5}, {Max: 5}},
		{{Max: 0}, {Max: 0}},
		{{Max: 100}},
	} {
		groups, leftover := PartitionCapped(stops, caps)
		seen := map[string]int{}
		for _, g := range groups {
			for _, p := range g {
				seen[p.ID]++
			}
		}
		for _, p := range leftover {
			seen[p.ID]++
		}
		if len(seen) != len(stops) {
			t.Fatalf("caps %v: %d distinct stops, want %d", caps, len(seen), len(stops))
		}
		for id, n := range seen {
			if n != 1 {
				t.Fatalf("caps %v: stop %s appears %d times", caps, id, n)
			}
		}
	}
}

// A capped driver should get stops that sit together, not an arbitrary
// slice — ten scattered houses is a worse round than ten neighbours.
func TestACappedDriverGetsAContiguousCluster(t *testing.T) {
	stops := lineOfStops(20)
	groups, _ := PartitionCapped(stops, []Capped{{Max: 5}, {Max: 0}})

	// The five should span far less than the whole line.
	spread := SpreadMeters(groups[0])
	whole := SpreadMeters(stops)
	if spread > whole/2 {
		t.Fatalf("the capped driver's 5 stops span %.0fm of a %.0fm line — that is not a cluster", spread, whole)
	}
}

// A cap decides how many stops a driver takes, never which priorities
// they take. Trimming a group has to drop the ordinary stops first, even
// when a priority one sits further from the cluster's centre.
func TestACapTrimsOrdinaryStopsBeforePriorityOnes(t *testing.T) {
	stops := []Point{}
	// Nine ordinary stops packed around the centre. Band 2 is what
	// domain.PriorityNormal ranks as — 0, the zero value, is the top
	// band, so an ordinary stop has to say so.
	for i := 0; i < 9; i++ {
		stops = append(stops, Point{ID: fmt.Sprintf("house-%d", i), Lat: 12.97 + float64(i)*0.0001, Lng: 77.59, Band: 2})
	}
	// One shop, deliberately the furthest thing out.
	stops = append(stops, Point{ID: "shop", Lat: 12.99, Lng: 77.62, Band: 0})

	groups, leftover := PartitionCapped(stops, []Capped{{Max: 3}})

	kept := map[string]bool{}
	for _, p := range groups[0] {
		kept[p.ID] = true
	}
	if !kept["shop"] {
		t.Fatalf("the cap dropped the shop and kept %v", kept)
	}
	if len(groups[0]) != 3 {
		t.Fatalf("group has %d stops, want 3", len(groups[0]))
	}
	if len(leftover) != 7 {
		t.Fatalf("%d stops left over, want 7", len(leftover))
	}
}
