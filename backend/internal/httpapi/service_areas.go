package httpapi

import (
	"log"
	"net/http"
	"strings"

	"delivery-manager/internal/domain"
)

// ---------- service areas ----------
//
// A service area is a named delivery zone — a city or locality a business
// declares it serves, as a center pin and a radius. It exists so every
// map in the app can default to a sane zoomed-in view instead of an
// India-wide one, and so today's stops can be grouped by zone for
// one-click route building (see the frontend's TodayScreen). Like
// Customer, it has no domain.Validate() of its own — this is the one
// place it's written, so validation lives here.

type serviceAreaRequest struct {
	Name         string  `json:"name"`
	Lat          float64 `json:"lat"`
	Lng          float64 `json:"lng"`
	RadiusMeters float64 `json:"radius_meters"`
	// A pointer so PATCH can leave Active untouched when the caller isn't
	// trying to pause/resume the area — same convention as
	// customerRequest.Active.
	Active *bool `json:"active"`
}

func (s *Server) handleListServiceAreas(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	areas, err := s.store.ListServiceAreas(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "service areas")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"service_areas": areas})
}

func (s *Server) handleCreateServiceArea(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req serviceAreaRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required", "missing_fields")
		return
	}
	if !validCoordinates(req.Lat, req.Lng) {
		writeError(w, http.StatusBadRequest, "lat must be between -90 and 90 and lng between -180 and 180", "invalid_location")
		return
	}
	if !validRadiusMeters(req.RadiusMeters) {
		writeError(w, http.StatusBadRequest, "radius_meters must be between 100 and 75000", "invalid_radius")
		return
	}

	created, err := s.store.CreateServiceArea(r.Context(), domain.ServiceArea{
		ID:           domain.NewID(),
		BusinessID:   sess.Business.ID,
		Name:         strings.TrimSpace(req.Name),
		Lat:          req.Lat,
		Lng:          req.Lng,
		RadiusMeters: req.RadiusMeters,
		Active:       true,
	})
	if err != nil {
		writeStoreError(w, err, "service area")
		return
	}

	kept, err := s.keepCustomersWhereTheyAre(r, sess, created)
	if err != nil {
		// The route exists and is usable; failing the request now would
		// be worse than a stale membership the next edit fixes.
		log.Printf("freeze memberships after creating service route %s: %v", created.ID, err)
	}

	writeJSON(w, http.StatusCreated, createdServiceArea{ServiceArea: created, Kept: kept})
}

// A customer the new route would have taken from a route they were
// already on, and the route they stayed on instead.
type keptCustomer struct {
	CustomerID   string `json:"customer_id"`
	CustomerName string `json:"customer_name"`
	RouteID      string `json:"route_id"`
	RouteName    string `json:"route_name"`
}

// The created route, plus who it deliberately did not take. Embedded so
// the route's own fields stay at the top level and every existing
// caller keeps working.
type createdServiceArea struct {
	domain.ServiceArea
	Kept []keptCustomer `json:"kept"`
}

// keepCustomersWhereTheyAre stops a new service route from quietly
// emptying an existing one.
//
// Routes claim customers by pin, nearest centre wins. Draw a second
// circle over a town you already deliver to and it takes whichever
// customers happen to sit closer to the new middle — silently, off a
// round the owner had already settled and may have printed. Nobody asks
// for that by drawing a circle.
//
// So the moment a new route would move somebody, they are pinned to the
// route they were already on. The new route still picks up customers no
// route covered before, which is the case that makes drawing a circle
// worth doing. The ones it passed over come back in the response so the
// screen can offer to hand them over — see handleAddCustomersToRoute.
func (s *Server) keepCustomersWhereTheyAre(
	r *http.Request, sess session, created domain.ServiceArea,
) ([]keptCustomer, error) {
	areas, err := s.store.ListServiceAreas(r.Context(), sess.Business.ID)
	if err != nil {
		return nil, err
	}
	before := make([]domain.ServiceArea, 0, len(areas))
	for _, area := range areas {
		if area.ID != created.ID {
			before = append(before, area)
		}
	}
	if len(before) == 0 {
		return nil, nil // the first route can't take anybody off anything
	}

	customers, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		return nil, err
	}

	kept := []keptCustomer{}
	for _, c := range customers {
		// Somebody placed by hand is already immune, and an inactive or
		// unpinned customer was never claimed by geography at all.
		if !c.Active || c.ServiceAreaID != nil || !c.HasPin() {
			continue
		}
		was, hadRoute := areaForCustomer(c, before)
		if !hadRoute {
			continue
		}
		now, _ := areaForCustomer(c, areas)
		if now.ID == was.ID {
			continue
		}
		c.ServiceAreaID = &was.ID
		if _, err := s.store.UpdateCustomer(r.Context(), c); err != nil {
			return kept, err
		}
		kept = append(kept, keptCustomer{
			CustomerID: c.ID, CustomerName: c.Name,
			RouteID: was.ID, RouteName: was.Name,
		})
	}
	if len(kept) > 0 {
		log.Printf("service route %s kept %d customers on the routes they were already on", created.Name, len(kept))
	}
	return kept, nil
}

// handleUpdateServiceArea is PATCH-partial exactly like
// handleUpdateCustomer: an omitted field keeps its stored value. Lat and
// Lng travel together (a lone one would silently move the pin to a
// broken location, same reasoning as the business's own home location).
func (s *Server) handleUpdateServiceArea(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	existing, err := s.store.GetServiceArea(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "service area")
		return
	}

	var req serviceAreaRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if strings.TrimSpace(req.Name) != "" {
		existing.Name = strings.TrimSpace(req.Name)
	}
	if req.Lat != 0 || req.Lng != 0 {
		if !validCoordinates(req.Lat, req.Lng) {
			writeError(w, http.StatusBadRequest, "lat must be between -90 and 90 and lng between -180 and 180", "invalid_location")
			return
		}
		existing.Lat, existing.Lng = req.Lat, req.Lng
	}
	if req.RadiusMeters != 0 {
		if !validRadiusMeters(req.RadiusMeters) {
			writeError(w, http.StatusBadRequest, "radius_meters must be between 100 and 75000", "invalid_radius")
			return
		}
		existing.RadiusMeters = req.RadiusMeters
	}
	if req.Active != nil {
		existing.Active = *req.Active
	}

	updated, err := s.store.UpdateServiceArea(r.Context(), existing)
	if err != nil {
		writeStoreError(w, err, "service area")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// validRadiusMeters bounds a service area to something a delivery round
// could plausibly cover: 100m (a single street) to 75km (a wide semi-rural
// territory) — a product judgment call, not an architectural one.
func validRadiusMeters(m float64) bool { return m >= 100 && m <= 75000 }

// handleAddCustomersToRoute moves customers onto this service route by
// hand — the other half of keepCustomersWhereTheyAre.
//
// Creating a route deliberately leaves settled customers alone, which is
// the safe default and the wrong one when the new route is a *better*
// description of where they belong. That case is a button rather than a
// guess: the screen offers to hand them over, and this is what it calls.
func (s *Server) handleAddCustomersToRoute(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	area, err := s.store.GetServiceArea(r.Context(), sess.Business.ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err, "service route")
		return
	}

	var req struct {
		CustomerIDs []string `json:"customer_ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	moved := 0
	for _, id := range req.CustomerIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		customer, err := s.store.GetCustomer(r.Context(), sess.Business.ID, id)
		if err != nil {
			writeStoreError(w, err, "customer")
			return
		}
		if customer.ServiceAreaID != nil && *customer.ServiceAreaID == area.ID {
			continue
		}
		customer.ServiceAreaID = &area.ID
		if _, err := s.store.UpdateCustomer(r.Context(), customer); err != nil {
			writeStoreError(w, err, "customer")
			return
		}
		// Today's delivery is on the round they used to be on.
		if err := s.detachTodaysStops(r, sess, customer.ID); err != nil {
			log.Printf("detach today's stops after moving %s onto %s: %v", customer.ID, area.Name, err)
		}
		moved++
	}

	log.Printf("moved %d customers onto service route %s", moved, area.Name)
	writeJSON(w, http.StatusOK, map[string]any{"moved": moved})
}
