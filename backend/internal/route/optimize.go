// Package route turns an unordered set of delivery pins into a sensible
// visiting order.
//
// V1 deliberately has no routing-API dependency. Distances are
// straight-line (haversine) rather than road distances, and navigation is
// delegated to whatever map app the driver already has (see the frontend's
// navigation deep link). That is a real trade-off, made knowingly:
//
//   - What it costs: the ordering ignores one-way streets, rivers,
//     level crossings and traffic. On a route where two pins are 200m
//     apart across a motorway, it will happily order them adjacently.
//   - What it buys: zero per-request cost and zero external dependency
//     on the critical morning path. A milk round is typically 30-80 stops
//     within a couple of square kilometres of dense, well-connected
//     residential streets, where straight-line proximity and road
//     proximity agree closely enough that the ordering is usually the
//     same one a human would pick.
//
// Optimize is kept behind a small, boring signature precisely so that
// swapping in a real distance matrix later (OSRM, ORS, Google Distance
// Matrix) is a change to how the cost between two points is obtained, not
// a change to anything that calls this.
package route

import "math"

// earthRadiusMeters is the mean radius. Delivery rounds span kilometres,
// not continents, so mean-radius haversine error (a few tenths of a
// percent) is far below the error already introduced by ignoring roads.
const earthRadiusMeters = 6371000.0

// Point is a routable location. ID is opaque to this package — it exists
// so callers can map the ordered result back to their own records.
type Point struct {
	ID  string
	Lat float64
	Lng float64
}

// DistanceMeters returns the great-circle distance between two points.
func DistanceMeters(aLat, aLng, bLat, bLng float64) float64 {
	lat1 := aLat * math.Pi / 180
	lat2 := bLat * math.Pi / 180
	dLat := (bLat - aLat) * math.Pi / 180
	dLng := (bLng - aLng) * math.Pi / 180

	h := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1)*math.Cos(lat2)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadiusMeters * math.Asin(math.Sqrt(math.Min(1, h)))
}

// Optimize orders stops into a route starting from start, returning the
// ordered stops and the total straight-line distance of the resulting
// path (start -> stop 1 -> ... -> stop N; the return leg to the depot is
// not counted, since a milk round typically ends wherever it ends).
//
// The route is built nearest-neighbour and then improved by 2-opt. That
// pairing is the standard cheap answer to a travelling-salesman instance:
// nearest-neighbour alone reliably produces one or two badly crossed legs
// (it greedily strands a far pin for last), and 2-opt's only job is to
// uncross them. For the 30-80 stop rounds this product targets, the pair
// runs in well under a millisecond and lands close enough to optimal that
// the remaining gap is dwarfed by the straight-line approximation itself.
//
// Ordering is deterministic: the same input always yields the same route,
// so an admin who rebuilds a route without changing anything doesn't get
// a reshuffled list and lose their place.
func Optimize(start Point, stops []Point) ([]Point, float64) {
	return optimize(start, stops, nil)
}

// OptimizeReturning is Optimize for a round that finishes somewhere
// specific — pass the depot to send the driver home at the end.
//
// This is a different problem, not a cosmetic addition: an open path is
// free to strand its last stop anywhere, because getting home afterwards
// costs it nothing. Once the drive home counts, the best order changes,
// and the tour that was cheapest as a one-way path is often not the
// cheapest loop. So the closing leg is part of what 2-opt is minimising
// here, rather than something added to the total afterwards.
func OptimizeReturning(start Point, stops []Point, end Point) ([]Point, float64) {
	return optimize(start, stops, &end)
}

func optimize(start Point, stops []Point, end *Point) ([]Point, float64) {
	if len(stops) == 0 {
		return []Point{}, 0
	}

	ordered := nearestNeighbour(start, stops)
	ordered = twoOpt(start, ordered, end)
	return ordered, pathLength(start, ordered, end)
}

// nearestNeighbour repeatedly hops to the closest not-yet-visited stop.
// Ties break on the earlier index, which is what makes the whole function
// deterministic for co-located pins (two customers in the same apartment
// block are a genuinely common case).
func nearestNeighbour(start Point, stops []Point) []Point {
	remaining := make([]Point, len(stops))
	copy(remaining, stops)

	ordered := make([]Point, 0, len(stops))
	current := start

	for len(remaining) > 0 {
		bestIdx := 0
		bestDist := math.Inf(1)
		for i, candidate := range remaining {
			d := DistanceMeters(current.Lat, current.Lng, candidate.Lat, candidate.Lng)
			if d < bestDist {
				bestDist = d
				bestIdx = i
			}
		}
		current = remaining[bestIdx]
		ordered = append(ordered, current)
		remaining = append(remaining[:bestIdx], remaining[bestIdx+1:]...)
	}
	return ordered
}

// twoOpt repeatedly reverses any sub-path that shortens the total route,
// which is exactly the move that removes a crossing. It runs to a local
// optimum (a full pass with no improvement) rather than for a fixed number
// of rounds, bounded by maxPasses so a pathological input can't spin.
func twoOpt(start Point, ordered []Point, end *Point) []Point {
	const maxPasses = 40
	// Below 4 stops there is no crossing to remove: any 2-opt move on 3
	// or fewer points either is a no-op or just reverses the whole path.
	if len(ordered) < 4 {
		return ordered
	}

	route := make([]Point, len(ordered))
	copy(route, ordered)

	for pass := 0; pass < maxPasses; pass++ {
		improved := false
		for i := 0; i < len(route)-1; i++ {
			for j := i + 1; j < len(route); j++ {
				// Reversing route[i:j+1] changes only the two edges at
				// the boundary, so the delta can be evaluated in O(1)
				// instead of re-measuring the whole path.
				before := edgeInto(start, route, i) + edgeOutOf(route, j, end)
				after := distance(pointBefore(start, route, i), route[j]) + edgeOutOfReversed(route, i, j, end)
				if after+1e-9 < before {
					reverse(route, i, j)
					improved = true
				}
			}
		}
		if !improved {
			break
		}
	}
	return route
}

// pointBefore returns the point the route is coming *from* when it arrives
// at index i — the depot for the first stop, the previous stop otherwise.
func pointBefore(start Point, route []Point, i int) Point {
	if i == 0 {
		return start
	}
	return route[i-1]
}

func edgeInto(start Point, route []Point, i int) float64 {
	return distance(pointBefore(start, route, i), route[i])
}

// edgeOutOf is the leg leaving index j. On an open round the final stop
// has no outgoing leg and contributes nothing; on a returning round it
// is the drive home.
func edgeOutOf(route []Point, j int, end *Point) float64 {
	if j+1 >= len(route) {
		if end != nil {
			return distance(route[j], *end)
		}
		return 0
	}
	return distance(route[j], route[j+1])
}

// edgeOutOfReversed is edgeOutOf as it would be *after* reversing i..j,
// where route[i] has become the segment's last point.
func edgeOutOfReversed(route []Point, i, j int, end *Point) float64 {
	if j+1 >= len(route) {
		if end != nil {
			return distance(route[i], *end)
		}
		return 0
	}
	return distance(route[i], route[j+1])
}

func distance(a, b Point) float64 {
	return DistanceMeters(a.Lat, a.Lng, b.Lat, b.Lng)
}

func reverse(route []Point, i, j int) {
	for i < j {
		route[i], route[j] = route[j], route[i]
		i++
		j--
	}
}

// pathLength totals the legs actually driven: depot to first stop, then
// stop to stop.
func pathLength(start Point, ordered []Point, end *Point) float64 {
	if len(ordered) == 0 {
		return 0
	}
	total := distance(start, ordered[0])
	for i := 0; i < len(ordered)-1; i++ {
		total += distance(ordered[i], ordered[i+1])
	}
	if end != nil {
		total += distance(ordered[len(ordered)-1], *end)
	}
	return total
}
