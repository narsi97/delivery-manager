package httpapi

import (
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
	writeJSON(w, http.StatusCreated, created)
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
