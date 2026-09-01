package httpapi

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/route"
	"delivery-manager/internal/storage"
)

// maxAreaDrivers caps how many drivers one area can be split between.
// Same reasoning as maxPlannedRounds: not a technical limit, just the
// point past which a picker stops being a picker.
const maxAreaDrivers = 10

// handleSetAreaDrivers says who is delivering one area today, and lets
// the split fall out of that.
//
// This is the whole route-planning interface a normal business needs. An
// admin does not think "I would like three routes cut geographically from
// today's work" — they think "Ravi, Kumar and Anita are doing Nalgonda
// this morning". Given those names, everything else is derivable: how
// many ways to cut the area (one per driver), where each cut should go
// (the cluster nearest that driver's own home, see
// route.AssignToFinishes), and what order each driver visits their stops
// in (route.OptimizeReturning, ending at their home).
//
// So this replaces "Create routes → several at once" as the way a
// multi-driver day gets planned. That flow asked for a count and cut the
// *entire day* geographically, ignoring service areas — which is why it
// had to wipe the day's routes to run. This is scoped to one area and
// composes with the automatic per-area routes instead of fighting them:
// other areas are untouched, and tomorrow's routes still derive
// themselves.
//
// Assigning one driver produces exactly what assigning a driver has
// always produced — a single route for the area, ending at their home —
// so the common one-van business never sees a difference.
func (s *Server) handleSetAreaDrivers(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		DriverIDs []string `json:"driver_ids"`
		Date      string   `json:"date"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if len(req.DriverIDs) > maxAreaDrivers {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("an area can be split between at most %d drivers", maxAreaDrivers), "too_many_drivers")
		return
	}

	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = sess.Business.Today()
	}
	if !validDate(date) {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	area, err := s.store.GetServiceArea(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "service area")
		return
	}

	// Resolve every driver before changing anything, so a typo in the
	// third id doesn't leave the area half re-planned. Duplicates are
	// dropped rather than rejected: asking for the same driver twice
	// means one route for them, not an error.
	drivers := make([]domain.User, 0, len(req.DriverIDs))
	seen := map[string]bool{}
	for _, id := range req.DriverIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		driver, err := s.store.GetUserByID(r.Context(), sess.Business.ID, id)
		if err != nil {
			writeStoreError(w, err, "driver")
			return
		}
		if !driver.Role.CanDrive() {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("%s is not a driver", driver.Name), "not_a_driver")
			return
		}
		if !driver.Active {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("%s's account is deactivated", driver.Name), "driver_inactive")
			return
		}
		drivers = append(drivers, driver)
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}
	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "customers")
		return
	}
	customersByID := map[string]domain.Customer{}
	for _, c := range customers {
		customersByID[c.ID] = c
	}
	areas, err := s.store.ListServiceAreas(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "service areas")
		return
	}
	existing, err := s.store.ListRoutes(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "routes")
		return
	}

	// Routes carrying finished work are history, not plan — leave them
	// exactly as they are and plan around them, same discipline as
	// handlePlanRounds. Their stops are therefore not up for re-cutting.
	completedOn := map[string]bool{}
	for _, o := range orders {
		if o.Status != domain.StatusPending && o.RouteID != nil {
			completedOn[*o.RouteID] = true
		}
	}

	// This area's own routes, by the same containment test ensureDayRounds
	// uses to recognise them — so a route an admin built by hand near the
	// area's centre is re-planned along with the derived ones rather than
	// left orphaned beside them.
	mine := map[string]bool{}
	for _, rt := range existing {
		if found, ok := areaContaining(rt.StartLat, rt.StartLng, areas); ok && found.ID == area.ID {
			mine[rt.ID] = true
		}
	}

	// The work to hand out: pending, pinned, inside this area, and not
	// already locked to a route being kept.
	points := make([]route.Point, 0, len(orders))
	for _, o := range orders {
		if o.Status != domain.StatusPending {
			continue
		}
		if o.RouteID != nil && completedOn[*o.RouteID] {
			continue
		}
		customer, known := customersByID[o.CustomerID]
		if !known || !customer.HasPin() {
			continue
		}
		if found, ok := areaContaining(customer.Lat, customer.Lng, areas); !ok || found.ID != area.ID {
			continue
		}
		points = append(points, route.Point{ID: o.ID, Lat: customer.Lat, Lng: customer.Lng, Band: customer.Priority.Rank()})
	}

	start := route.Point{Lat: area.Lat, Lng: area.Lng}

	// Names must dodge every route being kept, across all areas — one
	// route per name per day is a database constraint. Splitting names by
	// driver ("Nalgonda · Ravi") is deliberate: it is what the driver sees
	// when they open the app, and a driver looking for their own round
	// should find their own name, not "Route 2".
	taken := map[string]bool{}
	for _, rt := range existing {
		if !mine[rt.ID] || completedOn[rt.ID] {
			taken[rt.Name] = true
		}
	}
	unique := func(base string) string {
		if !taken[base] {
			taken[base] = true
			return base
		}
		for n := 2; ; n++ {
			candidate := fmt.Sprintf("%s (%d)", base, n)
			if !taken[candidate] {
				taken[candidate] = true
				return candidate
			}
		}
	}

	type planned struct {
		name       string
		driverID   *string
		endLat     float64
		endLng     float64
		orderedIDs []string
		meters     float64
	}
	plans := make([]planned, 0, len(drivers))

	switch {
	case len(drivers) == 0:
		// Nobody assigned: fall back to the shape ensureDayRounds would
		// have produced on its own — one unassigned route for the area —
		// so un-assigning everyone returns the day to its derived state
		// rather than deleting the area's work off the map.
		ordered, meters := route.OptimizePrioritised(start, points, nil)
		plans = append(plans, planned{
			name:       unique(area.Name + " route"),
			orderedIDs: idsOf(ordered),
			meters:     meters,
		})

	case len(drivers) == 1:
		driver := drivers[0]
		finishLat, finishLng, _ := driver.FinishPoint(sess.Business)
		ordered, meters := optimizeForDriver(start, points, driver, sess.Business)
		plans = append(plans, planned{
			name:       unique(area.Name + " route"),
			driverID:   &drivers[0].ID,
			endLat:     finishLat, endLng: finishLng,
			orderedIDs: idsOf(ordered),
			meters:     meters,
		})

	default:
		groups := route.Partition(points, len(drivers))
		finishes := make([]route.Point, len(drivers))
		for i, d := range drivers {
			finishes[i] = route.Point{Lat: d.HomeLat, Lng: d.HomeLng}
		}
		match := route.AssignToFinishes(groups, finishes)

		for g, group := range groups {
			if len(group) == 0 || match[g] < 0 {
				continue
			}
			driver := drivers[match[g]]
			finishLat, finishLng, _ := driver.FinishPoint(sess.Business)
			ordered, meters := optimizeForDriver(start, group, driver, sess.Business)
			plans = append(plans, planned{
				name:       unique(area.Name + " · " + driver.Name),
				driverID:   &drivers[match[g]].ID,
				endLat:     finishLat, endLng: finishLng,
				orderedIDs: idsOf(ordered),
				meters:     meters,
			})
		}
	}

	// Build the plan fully before touching the database, then swap: a
	// failure while planning leaves the area on its previous routes
	// rather than on none.
	for _, rt := range existing {
		if !mine[rt.ID] || completedOn[rt.ID] {
			continue
		}
		if err := s.store.DeleteRoute(r.Context(), sess.Business.ID, rt.ID); err != nil {
			writeStoreError(w, err, "route")
			return
		}
	}

	for _, p := range plans {
		status := domain.RouteDraft
		if p.driverID != nil {
			status = domain.RouteAssigned
		}
		created, err := s.store.CreateRoute(r.Context(), domain.Route{
			ID:              domain.NewID(),
			BusinessID:      sess.Business.ID,
			RouteDate:       date,
			Name:            p.name,
			DriverID:        p.driverID,
			Status:          status,
			StartLat:        start.Lat,
			StartLng:        start.Lng,
			EndLat:          p.endLat,
			EndLng:          p.endLng,
			EstimatedMeters: p.meters,
		})
		if err != nil {
			writeStoreError(w, err, "route")
			return
		}
		if len(p.orderedIDs) == 0 {
			continue
		}
		if err := s.store.AssignStops(r.Context(), sess.Business.ID, created.ID, p.orderedIDs); err != nil {
			writeStoreError(w, err, "route")
			return
		}
	}

	log.Printf("area %s on %s: %d stops across %d driver(s)", area.Name, date, len(points), len(drivers))

	s.respondWithDay(w, r, date)
}

// optimizeForDriver orders one driver's stops, ending at their home when
// they have one recorded. A driver with no home saved gets the
// open-ended ordering every route had before drivers had homes, rather
// than being sent to 0,0 in the Gulf of Guinea.
func optimizeForDriver(start route.Point, points []route.Point, driver domain.User, business domain.Business) ([]route.Point, float64) {
	if lat, lng, ok := driver.FinishPoint(business); ok {
		finish := route.Point{Lat: lat, Lng: lng}
		return route.OptimizePrioritised(start, points, &finish)
	}
	return route.OptimizePrioritised(start, points, nil)
}

func idsOf(points []route.Point) []string {
	ids := make([]string, 0, len(points))
	for _, p := range points {
		ids = append(ids, p.ID)
	}
	return ids
}

// prepareSplitArea recreates yesterday's multi-driver split for a new day.
//
// Called from ensureDayRounds when an area had several drivers yesterday
// and has no rounds yet today. It does the same thing
// handleSetAreaDrivers does — partition, match clusters to the drivers
// finishing nearest them, one round each — but writes its stop
// assignments into preAssigned rather than attaching them itself, so the
// caller's existing attach-and-optimize pass handles ordering exactly as
// it does for every other round. That pass reads Route.HasEnd, which is
// set here, so each driver's round is ordered to finish at their own home
// without this function having to duplicate the optimizer call.
func (s *Server) prepareSplitArea(
	r *http.Request,
	business domain.Business,
	date string,
	area domain.ServiceArea,
	crew []domain.User,
	areaOfOrder map[string]string,
	pinOfOrder map[string]route.Point,
	preAssigned map[string]string,
	routeForArea map[string]domain.Route,
	roundsInArea map[string][]domain.Route,
) error {
	// Deterministic input order: areaOfOrder is a map, and partitioning a
	// randomly-ordered slice would hand a driver a different cluster on
	// every read of the same unchanged day.
	orderIDs := make([]string, 0, len(areaOfOrder))
	for orderID, areaID := range areaOfOrder {
		if areaID == area.ID {
			orderIDs = append(orderIDs, orderID)
		}
	}
	sort.Strings(orderIDs)

	points := make([]route.Point, 0, len(orderIDs))
	for _, orderID := range orderIDs {
		pin := pinOfOrder[orderID]
		// pin already carries the customer's band — see ensureDayRoutes.
		points = append(points, route.Point{ID: orderID, Lat: pin.Lat, Lng: pin.Lng, Band: pin.Band})
	}
	if len(points) == 0 {
		return nil
	}

	groups := route.Partition(points, len(crew))
	finishes := make([]route.Point, len(crew))
	for i, d := range crew {
		finishes[i] = route.Point{Lat: d.HomeLat, Lng: d.HomeLng}
	}
	match := route.AssignToFinishes(groups, finishes)

	for g, group := range groups {
		if len(group) == 0 || match[g] < 0 {
			continue
		}
		driver := crew[match[g]]
		finishLat, finishLng, _ := driver.FinishPoint(business)
		created, err := s.store.CreateRoute(r.Context(), domain.Route{
			ID:         domain.NewID(),
			BusinessID: business.ID,
			RouteDate:  date,
			Name:       area.Name + " · " + driver.Name,
			DriverID:   &crew[match[g]].ID,
			Status:     domain.RouteAssigned,
			StartLat:   area.Lat,
			StartLng:   area.Lng,
			EndLat:     finishLat,
			EndLng:     finishLng,
		})
		if err != nil {
			// Another request preparing the same day got here first. Its
			// split is as good as this one, so leave the day to it rather
			// than failing a read — same reasoning as the single-round
			// conflict path in ensureDayRounds.
			if errors.Is(err, storage.ErrConflict) {
				return nil
			}
			return err
		}
		for _, p := range group {
			preAssigned[p.ID] = created.ID
		}
		if _, exists := routeForArea[area.ID]; !exists {
			routeForArea[area.ID] = created
		}
		roundsInArea[area.ID] = append(roundsInArea[area.ID], created)
		log.Printf("prepared %s for business %s on %s (%d stops)", created.Name, business.ID, date, len(group))
	}
	return nil
}
