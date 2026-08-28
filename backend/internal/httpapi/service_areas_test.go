package httpapi

import (
	"context"
	"net/http"
	"testing"

	"delivery-manager/internal/domain"
)

// secondBusinessAdminClient spins up a genuinely separate tenant — dev
// login (see handleDevLogin) is pinned to one fixed email and so always
// resolves back to the same business, which is right for exercising the
// admin/driver flow but useless for a tenant-isolation test. This goes
// around it the same way signup would, minus the Google token.
func secondBusinessAdminClient(t *testing.T, s *Server) *client {
	t.Helper()
	_, admin, err := s.createBusinessWithAdmin(context.Background(),
		"Second Business", domain.BusinessTypeDairy, "UTC", "second-admin@example.com", "Second Admin")
	if err != nil {
		t.Fatalf("create second business: %v", err)
	}
	token, err := s.auth.IssueToken(admin)
	if err != nil {
		t.Fatalf("issue token for second business admin: %v", err)
	}
	return &client{t: t, server: s, token: token}
}

func TestServiceAreaCreateListPatch(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	created := admin.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "Jayanagar", "lat": 12.93, "lng": 77.58, "radius_meters": 3000,
	}, http.StatusCreated)
	if str(created, "name") != "Jayanagar" {
		t.Fatalf("created service area name = %q, want Jayanagar", str(created, "name"))
	}
	if !created["active"].(bool) {
		t.Fatal("a newly created service area should be active")
	}
	id := str(created, "id")

	listed := admin.mustDo(http.MethodGet, "/api/v1/service-areas", nil, http.StatusOK)
	areas, _ := listed["service_areas"].([]any)
	if len(areas) != 1 {
		t.Fatalf("listed %d service areas, want 1", len(areas))
	}

	// Patching only the radius must leave the name and pin untouched —
	// same PATCH-partial contract as customers.
	updated := admin.mustDo(http.MethodPatch, "/api/v1/service-areas/"+id, map[string]any{
		"radius_meters": 5000,
	}, http.StatusOK)
	if str(updated, "name") != "Jayanagar" {
		t.Fatalf("name after a radius-only patch = %q, want Jayanagar", str(updated, "name"))
	}
	if num(updated, "lat") != 12.93 {
		t.Fatalf("lat after a radius-only patch = %v, want 12.93", num(updated, "lat"))
	}
	if num(updated, "radius_meters") != 5000 {
		t.Fatalf("radius_meters = %v, want 5000", num(updated, "radius_meters"))
	}

	// Pausing is how a service area is "removed" — no delete route exists.
	paused := admin.mustDo(http.MethodPatch, "/api/v1/service-areas/"+id, map[string]any{
		"active": false,
	}, http.StatusOK)
	if paused["active"].(bool) {
		t.Fatal("service area should be paused after active:false")
	}
}

func TestServiceAreaValidation(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	cases := map[string]any{
		"missing name": map[string]any{
			"lat": 12.93, "lng": 77.58, "radius_meters": 3000,
		},
		"invalid coordinates": map[string]any{
			"name": "Nowhere", "lat": 200, "lng": 77.58, "radius_meters": 3000,
		},
		"radius too small": map[string]any{
			"name": "Tiny", "lat": 12.93, "lng": 77.58, "radius_meters": 10,
		},
		"radius too large": map[string]any{
			"name": "Huge", "lat": 12.93, "lng": 77.58, "radius_meters": 500000,
		},
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			rec, _ := admin.do(http.MethodPost, "/api/v1/service-areas", body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("= %d, want 400", rec.Code)
			}
		})
	}
}

// The same tenant-isolation guarantee every other resource has — one
// business must never see another's service areas.
func TestServiceAreasDoNotLeakAcrossBusinesses(t *testing.T) {
	server := newTestServer(t)
	first := adminClient(t, server)
	second := secondBusinessAdminClient(t, server)

	first.mustDo(http.MethodPost, "/api/v1/service-areas", map[string]any{
		"name": "First Business Area", "lat": 12.93, "lng": 77.58, "radius_meters": 3000,
	}, http.StatusCreated)

	listed := second.mustDo(http.MethodGet, "/api/v1/service-areas", nil, http.StatusOK)
	areas, _ := listed["service_areas"].([]any)
	if len(areas) != 0 {
		t.Fatalf("second business sees %d service areas that aren't its own", len(areas))
	}
}

// The business's name and home location are readable from the session
// immediately after being saved — same "no follow-up request" guarantee
// TestSessionCarriesTheBusinessConfig makes for config.
func TestUpdateBusinessLocationIsReflectedInSession(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"name": "Anita's Dairy", "home_lat": 12.97, "home_lng": 77.59,
	}, http.StatusOK)

	me := admin.mustDo(http.MethodGet, "/api/v1/auth/me", nil, http.StatusOK)
	business, _ := me["business"].(map[string]any)
	if str(business, "name") != "Anita's Dairy" {
		t.Fatalf("session business name = %q, want Anita's Dairy", str(business, "name"))
	}
	if num(business, "home_lat") != 12.97 {
		t.Fatalf("session home_lat = %v, want 12.97", num(business, "home_lat"))
	}
}

func TestUpdateBusinessRejectsAHalfSetLocation(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)

	// home_lng omitted entirely — a lone lat must not silently move the
	// pin to a broken location.
	updated := admin.mustDo(http.MethodPatch, "/api/v1/business", map[string]any{
		"home_lat": 12.97,
	}, http.StatusOK)
	if num(updated, "home_lat") != 0 {
		t.Fatalf("home_lat was set from a half-sent location: %v", updated["home_lat"])
	}
}
