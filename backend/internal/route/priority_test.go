package route

import "testing"

// The whole point: a stop that matters is visited first even when the
// shortest path would leave it until last.
func TestHigherBandsAreVisitedFirst(t *testing.T) {
	start := Point{Lat: 12.90, Lng: 77.59}
	// "far" is a business customer on the far side; "near" two are
	// ordinary and sit right next to the depot. Shortest-path alone would
	// do the near pair first.
	bands := []Tiered{
		{Rank: 2, Points: []Point{{ID: "near1", Lat: 12.901, Lng: 77.59}, {ID: "near2", Lat: 12.902, Lng: 77.59}}},
		{Rank: 0, Points: []Point{{ID: "far", Lat: 12.95, Lng: 77.59}}},
	}

	ordered, _ := OptimizeTiered(start, bands, nil)
	if len(ordered) != 3 {
		t.Fatalf("got %d stops, want 3", len(ordered))
	}
	if ordered[0].ID != "far" {
		t.Fatalf("first stop is %q, want the business customer 'far' — tiers must beat distance", ordered[0].ID)
	}
}

// Bands are chained, not stapled: the second band starts from where the
// first ended, so the drive stays continuous.
func TestBandsStartWhereTheLastOneEnded(t *testing.T) {
	start := Point{Lat: 12.90, Lng: 77.59}
	bands := []Tiered{
		{Rank: 0, Points: []Point{{ID: "a1", Lat: 12.95, Lng: 77.59}, {ID: "a2", Lat: 12.96, Lng: 77.59}}},
		{Rank: 1, Points: []Point{{ID: "b1", Lat: 12.97, Lng: 77.59}, {ID: "b2", Lat: 12.91, Lng: 77.59}}},
	}

	ordered, _ := OptimizeTiered(start, bands, nil)
	ids := []string{}
	for _, p := range ordered {
		ids = append(ids, p.ID)
	}
	// Band A runs outward to a2 (12.96); band B should then take b1
	// (12.97, right next door) before doubling back to b2.
	if ids[2] != "b1" {
		t.Fatalf("order was %v — band B should continue from where band A ended, not restart at the depot", ids)
	}
}

// An empty band is not a band. It must not consume the "last band" slot
// and rob the real final band of its finish point.
func TestEmptyBandsDoNotTakeTheFinishPoint(t *testing.T) {
	start := Point{Lat: 12.90, Lng: 77.59}
	finish := Point{Lat: 12.80, Lng: 77.59}
	bands := []Tiered{
		{Rank: 0, Points: []Point{{ID: "a", Lat: 12.95, Lng: 77.59}, {ID: "b", Lat: 12.93, Lng: 77.59}}},
		{Rank: 1, Points: nil},
		{Rank: 2, Points: nil},
	}

	ordered, meters := OptimizeTiered(start, bands, &finish)
	if len(ordered) != 2 {
		t.Fatalf("got %d stops, want 2", len(ordered))
	}
	// With a finish point the closing leg counts, so the total must
	// exceed the one-way path.
	oneWay, _ := Optimize(start, bands[0].Points)
	_ = oneWay
	openMeters := pathLength(start, ordered, nil)
	if meters <= openMeters {
		t.Fatalf("total %.0fm did not include the drive to the finish point (open path is %.0fm)", meters, openMeters)
	}
}

func TestOptimizeTieredKeepsEveryStopExactlyOnce(t *testing.T) {
	start := Point{Lat: 12.90, Lng: 77.59}
	bands := []Tiered{
		{Rank: 0, Points: []Point{{ID: "a", Lat: 12.91, Lng: 77.59}}},
		{Rank: 1, Points: []Point{{ID: "b", Lat: 12.92, Lng: 77.60}, {ID: "c", Lat: 12.93, Lng: 77.58}}},
		{Rank: 2, Points: []Point{{ID: "d", Lat: 12.94, Lng: 77.59}, {ID: "e", Lat: 12.95, Lng: 77.61}}},
	}

	ordered, _ := OptimizeTiered(start, bands, nil)
	seen := map[string]int{}
	for _, p := range ordered {
		seen[p.ID]++
	}
	if len(seen) != 5 {
		t.Fatalf("got %d distinct stops, want 5", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("stop %s appears %d times", id, n)
		}
	}
}
