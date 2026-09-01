package route

import "sort"

// Ordering a route when some stops matter more than others.
//
// The optimizer on its own answers "what is the shortest way round?",
// which is the wrong question for a milk round where a shop opens at six
// and a household's children leave for school at half seven. A route
// that is optimal in kilometres and arrives after the child has gone is
// not optimal.
//
// So the tiers are honoured first and the path is optimised *within*
// them: every business customer is visited before every early customer,
// and every early customer before everyone else. Each band starts from
// where the last one finished, so the result is still one continuous
// sensible drive rather than three routes stapled together.
//
// The cost is real and worth being explicit about: a single business
// customer on the far side of town drags the start of the route out
// there and back. That is the trade the tier is *asking* for — it says
// this stop is worth bending the path for — but it means a badly
// assigned tier is expensive, not merely cosmetic.

// Tiered is a group of stops that share a priority, in the order the
// bands should be driven. Band 0 is visited first.
type Tiered struct {
	Rank   int
	Points []Point
}

// OptimizeTiered orders stops so that higher bands come first, running
// the ordinary optimizer inside each band and chaining them so each
// starts where the previous one ended.
//
// finish, when non-nil, is where the driver stops at the end — it only
// applies to the final band, since that is the only one whose last stop
// is actually the end of the day.
func OptimizeTiered(start Point, bands []Tiered, finish *Point) ([]Point, float64) {
	ordered := make([]Tiered, len(bands))
	copy(ordered, bands)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Rank < ordered[j].Rank })

	// Drop empty bands first, so "is this the last one" means the last
	// band with work in it rather than the last band that exists.
	live := make([]Tiered, 0, len(ordered))
	for _, band := range ordered {
		if len(band.Points) > 0 {
			live = append(live, band)
		}
	}
	if len(live) == 0 {
		return []Point{}, 0
	}

	out := make([]Point, 0)
	total := 0.0
	from := start
	for i, band := range live {
		var leg []Point
		var meters float64
		if i == len(live)-1 && finish != nil {
			leg, meters = OptimizeReturning(from, band.Points, *finish)
		} else {
			leg, meters = Optimize(from, band.Points)
		}
		out = append(out, leg...)
		total += meters
		if len(leg) > 0 {
			from = leg[len(leg)-1]
		}
	}
	return out, total
}

// OptimizePrioritised is the ordinary entry point: hand it every stop
// with its Band set and it does the grouping itself.
//
// This is what the handlers call, rather than assembling bands by hand.
// A caller that never sets Band gets one band containing everything,
// which is exactly Optimize/OptimizeReturning — so priority is opt-in at
// the point where a customer's tier is known, and nothing else had to
// change to accommodate it.
func OptimizePrioritised(start Point, points []Point, finish *Point) ([]Point, float64) {
	byBand := map[int][]Point{}
	order := []int{}
	for _, p := range points {
		if _, seen := byBand[p.Band]; !seen {
			order = append(order, p.Band)
		}
		byBand[p.Band] = append(byBand[p.Band], p)
	}

	bands := make([]Tiered, 0, len(order))
	for _, rank := range order {
		bands = append(bands, Tiered{Rank: rank, Points: byBand[rank]})
	}
	return OptimizeTiered(start, bands, finish)
}
