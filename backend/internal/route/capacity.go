package route

import "sort"

// Splitting a day when the drivers are not interchangeable.
//
// Partition assumes every driver takes an equal share, which is the right
// default and the wrong answer for how small dairies actually staff a
// morning. The owner does ten stops on the way to somewhere else; a
// friend helps out with a handful; the one full-time driver takes
// whatever is left. "Equal" would hand the friend forty houses.
//
// So a driver can carry a cap — at most this many stops — and the ones
// without a cap absorb the remainder. If every driver is capped and the
// caps don't cover the day, the leftover is returned rather than being
// forced onto somebody: an overflowing round is worse than an obviously
// unassigned stop, which the admin can see on the day screen and fix.

// Capped is one driver's share of the work: their cluster, and at most
// how many stops they will accept. Max <= 0 means no limit.
type Capped struct {
	Max int
}

// PartitionCapped cuts stops into len(caps) groups, honouring each
// group's maximum. Groups are returned in the same order as caps, so the
// caller can line them back up with the drivers they came from.
//
// Anything that cannot be placed within the caps comes back as leftover.
// That is a real state, not an error: an owner who says "I'll take ten"
// on a forty-stop day has genuinely only accounted for ten.
func PartitionCapped(stops []Point, caps []Capped) (groups [][]Point, leftover []Point) {
	groups = make([][]Point, len(caps))
	for i := range groups {
		groups[i] = []Point{}
	}
	if len(stops) == 0 || len(caps) == 0 {
		return groups, append([]Point{}, stops...)
	}

	// Start from the ordinary geographic split, so each driver's share is
	// still a tight cluster rather than an arbitrary slice. The caps then
	// trim it, and anything trimmed is offered to whoever has room.
	base := Partition(stops, len(caps))

	room := make([]int, len(caps))
	for i, c := range caps {
		if c.Max <= 0 {
			room[i] = len(stops) // effectively unlimited
		} else {
			room[i] = c.Max
		}
	}

	spill := []Point{}
	for i, group := range base {
		if i >= len(groups) {
			spill = append(spill, group...)
			continue
		}
		// Keep the stops nearest this group's own centre and spill the
		// rest: if a driver can only take ten, they should take the ten
		// that sit together, not the first ten in an arbitrary order.
		//
		// Band comes first, though. A shop that opens at six is on the
		// round because it has to be, and dropping it in favour of a
		// house that happens to sit nearer the middle of the cluster
		// would be the cap quietly overruling the priority — which is
		// the one thing a priority is for. See Point.Band.
		centre := Centroid(group)
		byDistance := make([]Point, len(group))
		copy(byDistance, group)
		sort.SliceStable(byDistance, func(a, b int) bool {
			if byDistance[a].Band != byDistance[b].Band {
				return byDistance[a].Band < byDistance[b].Band
			}
			da := DistanceMeters(centre.Lat, centre.Lng, byDistance[a].Lat, byDistance[a].Lng)
			db := DistanceMeters(centre.Lat, centre.Lng, byDistance[b].Lat, byDistance[b].Lng)
			if da != db {
				return da < db
			}
			return byDistance[a].ID < byDistance[b].ID
		})

		take := len(byDistance)
		if take > room[i] {
			take = room[i]
		}
		groups[i] = append(groups[i], byDistance[:take]...)
		room[i] -= take
		spill = append(spill, byDistance[take:]...)
	}

	// Offer the spill to whoever still has room, nearest group first, so
	// a stop trimmed off a full driver lands with the closest driver who
	// can still take it rather than the first one in the list. Priority
	// stops are offered first, for the same reason they were kept first:
	// when there isn't room for everyone, they are not the ones left out.
	sort.SliceStable(spill, func(a, b int) bool { return spill[a].Band < spill[b].Band })
	for _, p := range spill {
		best := -1
		bestDist := 0.0
		for i := range groups {
			if room[i] <= 0 {
				continue
			}
			centre := Centroid(groups[i])
			if len(groups[i]) == 0 {
				centre = p
			}
			d := DistanceMeters(centre.Lat, centre.Lng, p.Lat, p.Lng)
			if best == -1 || d < bestDist {
				best, bestDist = i, d
			}
		}
		if best == -1 {
			leftover = append(leftover, p)
			continue
		}
		groups[best] = append(groups[best], p)
		room[best]--
	}

	if leftover == nil {
		leftover = []Point{}
	}
	return groups, leftover
}
