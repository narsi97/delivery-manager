package httpapi

import (
	"net/http"
	"testing"
	"time"

	"delivery-manager/internal/domain"
)

// One customer's timeline is the exceptions to their standing order, so
// the thing worth testing is which deliveries get called special: an
// extra booked for a single date is, the standing order simply running
// is not.
func TestCustomerOrdersSeparatesSpecialFromStanding(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	productID := firstProductID(t, admin)
	customerID := createCustomer(t, admin, "Anitha Chary", 17.0510, 79.2670)
	createSubscription(t, admin, customerID, productID, 1)

	// Reading the day materializes the standing order for it.
	today := admin.mustDo(http.MethodGet, "/api/v1/day", nil, http.StatusOK)
	ahead, err := shiftDate(str(today, "date"), 5)
	if err != nil {
		t.Fatalf("shiftDate: %v", err)
	}
	admin.mustDo(http.MethodPost, "/api/v1/orders", map[string]any{
		"customer_id": customerID,
		"product_id":  productID,
		"quantity":    4,
		"date":        ahead,
		"note":        "Festival",
	}, http.StatusCreated)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers/"+customerID+"/orders", nil, http.StatusOK)
	orders, _ := body["orders"].([]any)
	if len(orders) < 2 {
		t.Fatalf("expected today's delivery and the booked extra, got %d", len(orders))
	}

	special, standing := 0, 0
	for _, raw := range orders {
		o, _ := raw.(map[string]any)
		if flag, _ := o["special"].(bool); flag {
			special++
			if str(o, "note") != "Festival" {
				t.Errorf("special order should be the booked extra, got note %q", str(o, "note"))
			}
		} else {
			standing++
		}
	}
	if special != 1 {
		t.Errorf("special orders = %d, want exactly the booked extra", special)
	}
	if standing == 0 {
		t.Error("today's standing delivery should be listed and not marked special")
	}
}

// The window is a cap, not a suggestion: asking for a decade gets the
// span the endpoint is willing to answer for rather than an error.
func TestCustomerOrdersClampsWindow(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	customerID := createCustomer(t, admin, "Anitha Chary", 17.0510, 79.2670)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers/"+customerID+"/orders?back=9999&ahead=9999", nil, http.StatusOK)
	from, err := time.Parse(domain.DateLayout, str(body, "from"))
	if err != nil {
		t.Fatalf("from: %v", err)
	}
	to, err := time.Parse(domain.DateLayout, str(body, "to"))
	if err != nil {
		t.Fatalf("to: %v", err)
	}
	today, err := time.Parse(domain.DateLayout, str(body, "today"))
	if err != nil {
		t.Fatalf("today: %v", err)
	}

	if got := int(today.Sub(from).Hours() / 24); got != maxHistoryDays {
		t.Errorf("history window = %d days back, want %d", got, maxHistoryDays)
	}
	if got := int(to.Sub(today).Hours() / 24); got != maxUpcomingDays {
		t.Errorf("upcoming window = %d days ahead, want %d", got, maxUpcomingDays)
	}
}

// A smaller window than the cap is honoured, so the frontend can ask for
// what it will actually draw.
func TestCustomerOrdersHonoursSmallerWindow(t *testing.T) {
	server := newTestServer(t)
	admin := adminClient(t, server)
	customerID := createCustomer(t, admin, "Anitha Chary", 17.0510, 79.2670)

	body := admin.mustDo(http.MethodGet, "/api/v1/customers/"+customerID+"/orders?back=7&ahead=3", nil, http.StatusOK)
	from, _ := time.Parse(domain.DateLayout, str(body, "from"))
	to, _ := time.Parse(domain.DateLayout, str(body, "to"))
	today, _ := time.Parse(domain.DateLayout, str(body, "today"))

	if got := int(today.Sub(from).Hours() / 24); got != 7 {
		t.Errorf("history window = %d days back, want 7", got)
	}
	if got := int(to.Sub(today).Hours() / 24); got != 3 {
		t.Errorf("upcoming window = %d days ahead, want 3", got)
	}
}
