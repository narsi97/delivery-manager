package httpapi

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"delivery-manager/internal/domain"
)

// The bridge between the two books.
//
// The herd's milking sheet says what the animals gave. The delivery side
// says what the round needs, in bottles. Neither says whether there is
// enough milk, because milk moves around both: a farm short of its own
// buys cans in, every farm keeps some back for the house and for family,
// and an animal under treatment gives milk that has to be poured away. So
// the answer is a ledger for the day, in litres —
//
//	from the herd + bought in − kept back = available
//	                                        needed by the round
//
// — and one press that turns it into bottles on the shelf.
//
// Computed here and nowhere else. The Milking screen and the day board
// are both about to state a day's milk, and two screens adding it up two
// ways is two answers to one question.

// maxAdjustmentLitres is a ceiling on one entry. A dairy does not buy a
// tanker of milk in a morning, and the field is a number box somebody can
// lean on — which is exactly how a driver limit of nine billion reached
// the database once.
const maxAdjustmentLitres = 10000

// litreEpsilon absorbs floating point on litres: 1.5 + 0.5 is 2, not
// 1.9999999999999998, and a round that needs exactly what there is must
// not be reported as short.
const litreEpsilon = 0.001

// buildMilkLedger adds up one day's milk.
//
// Herd milk is every yield recorded on that day — not only from animals
// whose stage is "milking" now. An animal milked this morning and dried off
// this evening still gave this morning's milk, and a ledger for last week
// must not lose an animal's milk because she has since been dried off.
func (s *Server) buildMilkLedger(ctx context.Context, businessID, date string) (domain.MilkLedger, error) {
	ledger := domain.MilkLedger{
		Date:        date,
		Adjustments: []domain.MilkAdjustment{},
		Counted:     []string{},
		Unmeasured:  []string{},
	}

	yields, err := s.store.ListMilkYields(ctx, businessID, date)
	if err != nil {
		return ledger, err
	}
	events, err := s.store.ListAllHealthEvents(ctx, businessID)
	if err != nil {
		return ledger, err
	}
	// The same test the milking sheet uses (see handleHerdDay), so the
	// litres this ledger calls withheld are the litres that sheet shows
	// as discarded.
	withheld := map[string]bool{}
	for _, e := range events {
		if e.WithholdingOn(date) {
			withheld[e.AnimalID] = true
		}
	}
	for animalID, y := range yields {
		if withheld[animalID] {
			ledger.Withheld += y.Total()
		} else {
			ledger.Herd += y.Total()
		}
	}

	adjustments, err := s.store.ListMilkAdjustments(ctx, businessID, date)
	if err != nil {
		return ledger, err
	}
	ledger.Adjustments = adjustments
	for _, a := range adjustments {
		if a.Direction == domain.MilkIn {
			ledger.BoughtIn += a.Litres
		} else {
			ledger.KeptBack += a.Litres
		}
	}
	ledger.Available = ledger.Herd + ledger.BoughtIn - ledger.KeptBack

	products, err := s.store.ListProducts(ctx, businessID)
	if err != nil {
		return ledger, err
	}
	volume := map[string]float64{}
	name := map[string]string{}
	for _, p := range products {
		name[p.ID] = p.Name
		if ml := millilitresOf(p.Name); ml > 0 {
			volume[p.ID] = ml / 1000
			ledger.Counted = append(ledger.Counted, p.Name)
		}
	}

	orders, err := s.store.ListDailyOrders(ctx, businessID, date)
	if err != nil {
		return ledger, err
	}
	unmeasured := map[string]bool{}
	for _, o := range orders {
		if o.Status != domain.StatusPending {
			continue
		}
		litres, measured := volume[o.ProductID]
		if !measured {
			if n := name[o.ProductID]; n != "" && !unmeasured[n] {
				unmeasured[n] = true
				ledger.Unmeasured = append(ledger.Unmeasured, n)
			}
			continue
		}
		ledger.Needed += litres * o.Quantity
	}

	stock, err := s.store.ListProductStock(ctx, businessID, date)
	if err != nil {
		return ledger, err
	}
	for id, units := range stock {
		ledger.Bottled += volume[id] * units
	}

	ledger.Herd = roundLitres(ledger.Herd)
	ledger.Withheld = roundLitres(ledger.Withheld)
	ledger.BoughtIn = roundLitres(ledger.BoughtIn)
	ledger.KeptBack = roundLitres(ledger.KeptBack)
	ledger.Available = roundLitres(ledger.Available)
	ledger.Needed = roundLitres(ledger.Needed)
	ledger.Bottled = roundLitres(ledger.Bottled)
	return ledger, nil
}

// roundLitres keeps a ledger in the precision milk is measured in. Nobody
// pours a can to the millilitre, and 36.49999999 on a screen reads as a
// mistake somebody made.
func roundLitres(v float64) float64 {
	return math.Round(v*1000) / 1000
}

func (s *Server) handleMilkDay(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	date, ok := resolveDate(sess.Business, r)
	if !ok {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}
	ledger, err := s.buildMilkLedger(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	writeJSON(w, http.StatusOK, ledger)
}

func (s *Server) handleCreateMilkAdjustment(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Date      string  `json:"date"`
		Litres    float64 `json:"litres"`
		Direction string  `json:"direction"`
		Note      string  `json:"note"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	direction := strings.ToLower(strings.TrimSpace(req.Direction))
	if !domain.ValidMilkDirection(direction) {
		writeError(w, http.StatusBadRequest, "milk either came in or went out", "invalid_direction")
		return
	}
	if req.Litres <= 0 {
		writeError(w, http.StatusBadRequest, "how many litres?", "invalid_litres")
		return
	}
	if req.Litres > maxAdjustmentLitres {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("that is more milk than a day moves — %d litres at most", maxAdjustmentLitres), "invalid_litres")
		return
	}

	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = sess.Business.Today()
	} else if _, err := time.Parse(domain.DateLayout, date); err != nil {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	note := strings.TrimSpace(req.Note)
	if len(note) > 120 {
		note = note[:120]
	}

	saved, err := s.store.CreateMilkAdjustment(r.Context(), domain.MilkAdjustment{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		Date:       date,
		Litres:     roundLitres(req.Litres),
		Direction:  direction,
		Note:       note,
	})
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

// handleDeleteMilkAdjustment removes one line of a day's ledger.
//
// Not behind the delete window. This is the same kind of fact as a milk
// yield in a cell — bookkeeping for a day, usually corrected a minute
// after it was typed — and a milk yield is retyped without asking anybody
// to arm anything. The window exists for deletes that lose history.
func (s *Server) handleDeleteMilkAdjustment(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())
	if err := s.store.DeleteMilkAdjustment(r.Context(), sess.Business.ID, r.PathValue("id")); err != nil {
		writeStoreError(w, err, "milk entry")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleBottleMilk fills the shelf for the day's round from the day's milk.
//
// It fills each size up to what the round needs and no further, and it
// never lowers a figure somebody already typed — the admin who bottled
// ten extra litre bottles for walk-in sales did that on purpose.
//
// When there is not enough milk it refuses rather than choosing. Filling
// some sizes and not others is deciding which customers go without, and
// that is the farm's call to make with the ledger in front of it, not
// something one press should quietly do.
func (s *Server) handleBottleMilk(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Date string `json:"date"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	date := strings.TrimSpace(req.Date)
	if date == "" {
		date = sess.Business.Today()
	} else if _, err := time.Parse(domain.DateLayout, date); err != nil {
		writeError(w, http.StatusBadRequest, "date must be YYYY-MM-DD", "invalid_date")
		return
	}

	ledger, err := s.buildMilkLedger(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "milk")
		return
	}
	if ledger.Needed <= 0 {
		writeError(w, http.StatusBadRequest, "nothing on this day needs milk", "nothing_needed")
		return
	}
	if ledger.Available+litreEpsilon < ledger.Needed {
		writeError(w, http.StatusConflict,
			fmt.Sprintf("short by %s L — buy some in, keep less back, or fill the sizes by hand",
				formatLitres(ledger.Needed-ledger.Available)),
			"short")
		return
	}

	products, err := s.store.ListProducts(r.Context(), sess.Business.ID)
	if err != nil {
		writeStoreError(w, err, "products")
		return
	}
	measured := map[string]bool{}
	for _, p := range products {
		if millilitresOf(p.Name) > 0 {
			measured[p.ID] = true
		}
	}

	orders, err := s.store.ListDailyOrders(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "deliveries")
		return
	}
	needed := map[string]float64{}
	for _, o := range orders {
		if o.Status == domain.StatusPending && measured[o.ProductID] {
			needed[o.ProductID] += o.Quantity
		}
	}

	stock, err := s.store.ListProductStock(r.Context(), sess.Business.ID, date)
	if err != nil {
		writeStoreError(w, err, "stock")
		return
	}

	filled := map[string]float64{}
	for id, units := range needed {
		if stock[id] >= units {
			continue
		}
		if err := s.store.SetProductStock(r.Context(), sess.Business.ID, id, date, units); err != nil {
			writeStoreError(w, err, "stock")
			return
		}
		filled[id] = units
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"date":      date,
		"filled":    filled,
		"left_over": roundLitres(ledger.Available - ledger.Needed),
	})
}

// formatLitres says a litre figure the way a person would: 4 rather than
// 4.000, 4.5 rather than 4.500.
func formatLitres(v float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", roundLitres(v)), "0"), ".")
}
