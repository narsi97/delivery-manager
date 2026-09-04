package httpapi

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"delivery-manager/internal/domain"
)

// Bringing a customer list in from a file.
//
// Every business that is worth onboarding already has its list somewhere
// — a notebook, a spreadsheet, a PDF a previous system printed. The first
// real one arrived as thirty-four households in a PDF, and typing those
// in by hand is both the dullest possible first hour with a new product
// and the one most likely to end with somebody deciding it isn't worth
// it.
//
// Two things this deliberately does NOT do:
//
// It does not parse the CSV. The browser does that, because the browser
// also has to resolve "17°03'24.3"N 79°16'05.4"E" and "X429+VC" into a
// pin, and there is exactly one place in this codebase that knows how
// (mapLinks.js). A second implementation in Go would be a second set of
// bugs, and the preview would stop agreeing with the import.
//
// It is not a transaction. Rows are created one at a time and the result
// says what happened to each. That is the honest shape: the alternative
// to "seven of thirty-four failed, here they are" is "nothing happened,
// find out why", and re-running is what people actually want. Which is
// why a customer who already exists is skipped rather than duplicated —
// running the same file twice finishes the job instead of doubling it.

type importItem struct {
	// What the file called the product — "500 ML", "Milk 1L", "curd".
	// Matched against this business's products rather than trusted.
	Product  string  `json:"product"`
	Quantity float64 `json:"quantity"`
}

type importRow struct {
	Name    string       `json:"name"`
	Phone   string       `json:"phone"`
	Address string       `json:"address"`
	Lat     float64      `json:"lat"`
	Lng     float64      `json:"lng"`
	Items   []importItem `json:"items"`
	// Which days this row's standing orders run. Empty means every day,
	// which is what a list with no such column means.
	Weekdays []int `json:"weekdays"`
	Notes    string `json:"notes"`
}

type importRequest struct {
	Rows []importRow `json:"rows"`
	// A dry run says what would happen and changes nothing. The screen
	// asks for one first and shows the answer, so nobody commits a file
	// whose product names turned out to match nothing.
	DryRun bool `json:"dry_run"`
}

// What happened, or would happen, to one row.
type importResult struct {
	Row  int    `json:"row"`
	Name string `json:"name"`
	// "new", "duplicate" or "error".
	Verdict string `json:"verdict"`
	Problem string `json:"problem,omitempty"`
	// The products this row's items matched, for the preview to show
	// back — matching by name is a guess and deserves to be visible.
	Matched []string `json:"matched,omitempty"`
	// Set once the row has actually been created.
	CustomerID string `json:"customer_id,omitempty"`
}

const maxImportRows = 2000

func (s *Server) handleImportCustomers(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req importRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Rows) == 0 {
		writeError(w, http.StatusBadRequest, "there are no rows to import", "no_rows")
		return
	}
	if len(req.Rows) > maxImportRows {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("that file has %d rows; %d is the most that can be imported at once", len(req.Rows), maxImportRows),
			"too_many_rows")
		return
	}

	products, err := s.store.ListProducts(r.Context(), sess.Business.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}
	existing, err := s.store.ListCustomers(r.Context(), sess.Business.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error(), "store_error")
		return
	}

	// Who is already here. Name and phone together, because a list of
	// households has two people called "Jyothi" more often than it has
	// one person twice, and a name on its own would refuse the second.
	seen := map[string]bool{}
	for _, c := range existing {
		seen[customerKey(c.Name, c.Phone)] = true
	}

	results := make([]importResult, 0, len(req.Rows))
	created, skipped, failed := 0, 0, 0

	for i, row := range req.Rows {
		result := importResult{Row: i + 1, Name: strings.TrimSpace(row.Name)}

		problem, matched := s.checkImportRow(row, products)
		result.Matched = matched
		switch {
		case problem != "":
			result.Verdict = "error"
			result.Problem = problem
			failed++
		case seen[customerKey(row.Name, row.Phone)]:
			result.Verdict = "duplicate"
			result.Problem = "already on the list — this row will be skipped"
			skipped++
		default:
			result.Verdict = "new"
			created++
		}

		if !req.DryRun && result.Verdict == "new" {
			id, err := s.createImportedCustomer(r, sess, row, products)
			if err != nil {
				result.Verdict = "error"
				result.Problem = err.Error()
				created--
				failed++
			} else {
				result.CustomerID = id
				// Within one file, a name and number repeated twice is
				// the same household typed twice.
				seen[customerKey(row.Name, row.Phone)] = true
			}
		}
		results = append(results, result)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"dry_run": req.DryRun,
		"total":   len(req.Rows),
		"new":     created,
		"skipped": skipped,
		"failed":  failed,
		"results": results,
	})
}

// checkImportRow returns why a row cannot be imported, or "" and the
// names of the products its items matched.
func (s *Server) checkImportRow(row importRow, products []domain.Product) (string, []string) {
	if strings.TrimSpace(row.Name) == "" {
		return "no name — every customer needs one", nil
	}
	if !validCoordinates(row.Lat, row.Lng) {
		return "that pin is not a real place on earth", nil
	}
	if len(row.Weekdays) > 0 && domain.MaskFromWeekdays(row.Weekdays) == 0 {
		return "those delivery days are not days of the week", nil
	}

	matched := make([]string, 0, len(row.Items))
	for _, item := range row.Items {
		product := matchProduct(item.Product, products)
		if product == nil {
			return fmt.Sprintf("nothing here is called %q — add that product first, or fix the spelling", item.Product), matched
		}
		if item.Quantity <= 0 {
			return fmt.Sprintf("%s has no quantity", product.Name), matched
		}
		matched = append(matched, fmt.Sprintf("%g × %s", item.Quantity, product.Name))
	}
	return "", matched
}

func (s *Server) createImportedCustomer(r *http.Request, sess session, row importRow, products []domain.Product) (string, error) {
	customer := domain.Customer{
		ID:         domain.NewID(),
		BusinessID: sess.Business.ID,
		Name:       strings.TrimSpace(row.Name),
		Phone:      strings.TrimSpace(row.Phone),
		Address:    strings.TrimSpace(row.Address),
		Lat:        row.Lat,
		Lng:        row.Lng,
		Notes:      strings.TrimSpace(row.Notes),
		Priority:   domain.NormalizePriority(""),
		Active:     true,
	}
	saved, err := s.store.CreateCustomer(r.Context(), customer)
	if err != nil {
		return "", err
	}

	mask := domain.MaskFromWeekdays(row.Weekdays)
	if mask == 0 {
		// No days column, or an empty one: a delivery list is a list of
		// what happens every day unless it says otherwise.
		mask = domain.MaskFromWeekdays([]int{0, 1, 2, 3, 4, 5, 6})
	}
	for _, item := range row.Items {
		product := matchProduct(item.Product, products)
		if product == nil {
			continue
		}
		order := domain.RecurringOrder{
			ID:          domain.NewID(),
			BusinessID:  sess.Business.ID,
			CustomerID:  saved.ID,
			ProductID:   product.ID,
			Quantity:    item.Quantity,
			WeekdayMask: mask,
			StartDate:   sess.Business.Today(),
			Active:      true,
		}
		if _, err := s.store.CreateRecurringOrder(r.Context(), order); err != nil {
			// The customer exists and is useful without this line; the
			// alternative is a half-made record and a confusing error.
			return saved.ID, fmt.Errorf("added, but %s could not be ordered: %w", product.Name, err)
		}
	}
	return saved.ID, nil
}

// matchProduct finds the product a file's word means.
//
// Exactly is tried first, then loosely. "500 ML" in the size column of a
// dairy's list means the product called "Milk 500ml" — the list only ever
// held one kind of milk, so it never wrote the word. Loose matching is
// what makes such a file importable without an edit to every row, and it
// is safe here because an ambiguous word matches nothing rather than
// guessing between two products.
func matchProduct(text string, products []domain.Product) *domain.Product {
	want := normalizeSize(text)
	if want == "" {
		return nil
	}
	for i := range products {
		if normalizeSize(products[i].Name) == want {
			return &products[i]
		}
	}
	var hit *domain.Product
	for i := range products {
		name := normalizeSize(products[i].Name)
		if strings.Contains(name, want) || strings.Contains(want, name) {
			if hit != nil {
				// Two products could be meant. Better to say so than to
				// put curd on a milk round.
				return nil
			}
			hit = &products[i]
		}
	}
	return hit
}

// squash reduces a name to its letters and digits, lowercased, so
// "500 ML", "500ml" and "500-ML" are one word.
func squash(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// How a size is written down, versus how the product was named.
//
// A real list writes "1 Lit" where the product is called "Milk 1L", and
// "1 1/2 Lit" where it is "Milk 1.5L". Those are the same measurement
// spelled by two different people, and matching them by letters alone
// fails on every row — which is what the preview showed the first time a
// real file went through it.
//
// Only the two ways of saying a volume are normalised. Anything cleverer
// would be guessing at what a business sells, and the preview is there
// precisely so a guess is not needed.
var litreWords = strings.NewReplacer(
	"litres", "l", "liters", "l", "litre", "l", "liter", "l",
	"ltrs", "l", "ltr", "l", "lit", "l", "lts", "l",
)

// mixedFraction turns "1 1/2" into "1.5" and a bare "1/2" into "0.5".
var mixedFraction = regexp.MustCompile(`(\d+)?\s*(\d+)\s*/\s*(\d+)`)

func normalizeSize(s string) string {
	out := strings.ToLower(strings.TrimSpace(s))
	out = mixedFraction.ReplaceAllStringFunc(out, func(match string) string {
		parts := mixedFraction.FindStringSubmatch(match)
		whole, _ := strconv.ParseFloat(nonEmpty(parts[1], "0"), 64)
		num, _ := strconv.ParseFloat(parts[2], 64)
		den, _ := strconv.ParseFloat(parts[3], 64)
		if den == 0 {
			return match
		}
		return strconv.FormatFloat(whole+num/den, 'f', -1, 64)
	})
	// Millilitres first: "ml" ends in an l that the litre words would
	// otherwise leave alone, but "1 mlit" is nobody's spelling.
	out = strings.ReplaceAll(out, "millilitres", "ml")
	out = strings.ReplaceAll(out, "milliliters", "ml")
	out = strings.ReplaceAll(out, "mls", "ml")
	// Guard the ml so the litre replacer cannot reach inside it.
	out = strings.ReplaceAll(out, "ml", "\x00")
	out = litreWords.Replace(out)
	out = strings.ReplaceAll(out, "\x00", "ml")
	return squash(out)
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func customerKey(name, phone string) string {
	return squash(name) + "|" + domain.NormalizePhone(phone)
}
