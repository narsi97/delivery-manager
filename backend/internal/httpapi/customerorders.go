package httpapi

import (
	"net/http"
	"time"

	"delivery-manager/internal/domain"
)

// One customer's deliveries either side of today.
//
// Everything else in this app is organised by day: the round, the map,
// the driver's list. That is the right shape for running deliveries and
// the wrong shape for answering a question about a person — "what has
// this customer actually been getting?", or the one that costs money,
// "what have we already promised them next week?". A one-off booked a
// fortnight ago is invisible until the morning it arrives, which is the
// same as a surprise.
//
// Both directions come from one endpoint because they are one list with
// today in the middle of it, and splitting them would mean two round
// trips to draw a single timeline.

// howFar bounds a request. Ninety days back is about as far as anybody
// argues about a milk bill; thirty forward is past the end of any month
// somebody is planning. Both are caps, not defaults — the caller says
// what it wants and gets the smaller of the two.
const (
	maxHistoryDays  = 90
	maxUpcomingDays = 30
)

type customerOrderView struct {
	domain.DailyOrder
	ProductName string `json:"product_name"`
	ProductUnit string `json:"product_unit,omitempty"`
	// Special marks a delivery that is not simply the standing order
	// running: an extra booked for the day, a quantity moved, a skip.
	// Computed here so every caller agrees on what "special" means.
	Special bool `json:"special"`
}

func (s *Server) handleCustomerOrders(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	customerID := r.PathValue("id")

	customer, err := s.store.GetCustomer(r.Context(), sess.Business.ID, customerID)
	if err != nil {
		writeError(w, http.StatusNotFound, "no such customer", "not_found")
		return
	}

	today, err := time.Parse(domain.DateLayout, sess.Business.Today())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "cannot resolve today", "bad_today")
		return
	}
	back := clampDays(r.URL.Query().Get("back"), maxHistoryDays)
	ahead := clampDays(r.URL.Query().Get("ahead"), maxUpcomingDays)

	from := today.AddDate(0, 0, -back).Format(domain.DateLayout)
	to := today.AddDate(0, 0, ahead).Format(domain.DateLayout)

	orders, err := s.store.ListCustomerDailyOrders(r.Context(), sess.Business.ID, customer.ID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}

	products, err := s.store.ListProducts(r.Context(), sess.Business.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}
	named := make(map[string]domain.Product, len(products))
	for _, p := range products {
		named[p.ID] = p
	}

	out := make([]customerOrderView, 0, len(orders))
	for _, o := range orders {
		product := named[o.ProductID]
		out = append(out, customerOrderView{
			DailyOrder:  o,
			ProductName: product.Name,
			ProductUnit: product.Unit,
			// A delivery nothing standing produced is special however it
			// ended up: BaseQuantity zero means it was added for this date
			// alone, and IsOverridden covers a changed number or a skip.
			Special: o.BaseQuantity == 0 || o.IsOverridden(),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"customer_id": customer.ID,
		"from":        from,
		"to":          to,
		"today":       sess.Business.Today(),
		"orders":      out,
	})
}

// clampDays reads a day count from the query, falling back to the cap
// when it is missing or nonsense. Negative windows are meaningless here,
// so they become zero rather than an error nobody could act on.
func clampDays(raw string, max int) int {
	if raw == "" {
		return max
	}
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			return max
		}
		n = n*10 + int(c-'0')
		if n > max {
			return max
		}
	}
	return n
}
