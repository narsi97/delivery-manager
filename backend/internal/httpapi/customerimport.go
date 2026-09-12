package httpapi

import (
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
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
	Weekdays []int  `json:"weekdays"`
	Notes    string `json:"notes"`
}

type importRequest struct {
	Rows []importRow `json:"rows"`
	// Which service route every row joins. A file is usually one round —
	// somebody's morning list — so importing it *into* that round is
	// what the file means, and it is the only way a customer whose pin
	// is missing can be on a round at all.
	ServiceAreaID string `json:"service_area_id"`
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
	// Already on the list, but carrying the pin the record is missing —
	// so this row completes somebody rather than being skipped.
	FillsPin bool `json:"fills_pin,omitempty"`
	// A duplicate of an earlier row in this same file, rather than of
	// somebody already on the list. Both are skipped and both are
	// right to skip, but they are different facts about the file and
	// reading "already here" against an empty roster is bewildering.
	InFile bool `json:"in_file,omitempty"`
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

	// Checked once, before anything is written, so a bad id fails the
	// whole import rather than half of it.
	var route *string
	if strings.TrimSpace(req.ServiceAreaID) != "" {
		resolved, ok := s.resolveServiceRoute(w, r, sess, req.ServiceAreaID)
		if !ok {
			return
		}
		route = resolved
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
	//
	// Kept apart from the keys this file contributes, so the preview can
	// tell somebody which of the two it means. Against an empty roster,
	// "already here" is not something anybody can act on.
	// Holds the record rather than a yes/no: a row that matches somebody
	// already here can still be carrying something they are missing.
	onList := map[string]domain.Customer{}
	inFile := map[string]bool{}
	// The order this file arrives in is the order the business drives.
	// A delivery list is numbered 1..N because somebody worked out that
	// round, often years ago, and importing it as an unordered bag threw
	// that away — the roster came back alphabetical, which is nobody's
	// route. Ranks continue past whatever is already ranked, so a
	// top-up import lands after the existing round rather than
	// interleaved through it.
	rank := 0
	for _, c := range existing {
		onList[customerKey(c.Name, c.Phone)] = c
		if c.Rank > rank {
			rank = c.Rank
		}
	}

	results := make([]importResult, 0, len(req.Rows))
	created, skipped, failed, filled := 0, 0, 0, 0

	for i, row := range req.Rows {
		result := importResult{Row: i + 1, Name: strings.TrimSpace(row.Name)}

		problem, matched := s.checkImportRow(row, products)
		result.Matched = matched
		switch {
		case problem != "":
			result.Verdict = "error"
			result.Problem = problem
			failed++
		case hasKey(onList, customerKey(row.Name, row.Phone)):
			// Already here, and the file may still be worth reading: a
			// list imported before the reader could see its coordinates
			// left a roster of people with no pin, and re-importing it
			// skipped every one of them. A pin the app does not have is
			// not a duplicate of anything.
			//
			// Only ever filling a blank. A pin somebody placed by hand
			// is the better one — they stood at the door — so a file
			// never overwrites it.
			result.Verdict = "duplicate"
			already := onList[customerKey(row.Name, row.Phone)]
			if already.Lat == 0 && already.Lng == 0 && (row.Lat != 0 || row.Lng != 0) {
				result.FillsPin = true
				result.Problem = "already on the list, and this row has the pin they are missing"
				filled++
			} else {
				result.Problem = "already on the list — this row will be skipped"
				skipped++
			}
		case inFile[customerKey(row.Name, row.Phone)]:
			result.Verdict = "duplicate"
			result.InFile = true
			result.Problem = "the same name and number appear earlier in this file — they go in once"
			skipped++
		default:
			result.Verdict = "new"
			created++
			// Marked here rather than after the write, so a file that
			// lists the same household twice says so in the preview.
			// It was only tracked while actually importing, which meant
			// the preview promised thirty-eight and the import made
			// thirty-seven — the one number the preview exists to get
			// right.
			inFile[customerKey(row.Name, row.Phone)] = true
		}

		if !req.DryRun && result.FillsPin {
			already := onList[customerKey(row.Name, row.Phone)]
			already.Lat, already.Lng = row.Lat, row.Lng
			if _, err := s.store.UpdateCustomer(r.Context(), already); err != nil {
				result.Verdict = "error"
				result.Problem = fmt.Sprintf("could not give %s their pin: %v", already.Name, err)
				result.FillsPin = false
				filled--
				failed++
			} else {
				// So a file listing the same household twice does not
				// try to fill a pin that is now there.
				onList[customerKey(row.Name, row.Phone)] = already
			}
		}

		if !req.DryRun && result.Verdict == "new" {
			rank++
			id, err := s.createImportedCustomer(r, sess, row, products, rank, route)
			if err != nil {
				result.Verdict = "error"
				result.Problem = err.Error()
				created--
				failed++
				// They are not on the list after all, so a later row for
				// the same household should still be tried.
				delete(inFile, customerKey(row.Name, row.Phone))
			} else {
				result.CustomerID = id
			}
		}
		results = append(results, result)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"dry_run": req.DryRun,
		"total":   len(req.Rows),
		"new":     created,
		"skipped": skipped,
		"filled":  filled,
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
		if item.Quantity <= 0 {
			return fmt.Sprintf("%s has no quantity", item.Product), matched
		}
		lines := resolveItem(item.Product, item.Quantity, products)
		if len(lines) == 0 {
			// A volume that simply cannot be made is a different problem
			// from a word nobody recognises, and telling somebody to fix
			// their spelling when the spelling is fine sends them
			// looking in the wrong place.
			if millilitresOf(item.Product) > 0 {
				return fmt.Sprintf("%s cannot be made from the sizes you sell", item.Product), matched
			}
			return fmt.Sprintf("nothing here is called %q — add that product first, or fix the spelling", item.Product), matched
		}
		for _, line := range lines {
			matched = append(matched, fmt.Sprintf("%g × %s", line.quantity, line.product.Name))
		}
	}
	return "", matched
}

// One line of a delivery: a product this business actually sells, and
// how many of it.
type orderLine struct {
	product  *domain.Product
	quantity float64
}

// resolveItem turns what the file wrote into what the dairy can put in
// the van.
//
// The easy case is a product with that name. The other case is a list
// written in milk rather than in bottles: a round that says "2 Lit"
// against a dairy that fills 1-litre bottles means two bottles, and
// "1 1/2 Lit" means a litre and a half-litre. Refusing those rows — or
// worse, expecting somebody to invent a "Milk 2L" product to hold them —
// makes the business change its catalogue to suit a file.
//
// Made up largest-first, which is how anybody fills a crate, and only
// when it comes out exact. A volume that cannot be made from the sizes
// on the shelf is still an error, because the alternative is delivering
// an amount nobody asked for.
func resolveItem(text string, quantity float64, products []domain.Product) []orderLine {
	if product := matchProduct(text, products); product != nil {
		return []orderLine{{product: product, quantity: quantity}}
	}

	want := millilitresOf(text)
	if want <= 0 {
		return nil
	}

	// Only sizes of one product can be added together. Two families with
	// volumes — milk and curd, both sold by the litre — mean the file's
	// bare "2 Lit" could be either, and a guess would put curd on a milk
	// round. See matchProduct, which refuses ambiguity for the same
	// reason.
	stem := stemOf(text)
	families := map[string][]orderLine{}
	for i := range products {
		if !products[i].Active {
			continue
		}
		size := millilitresOf(products[i].Name)
		if size <= 0 {
			continue
		}
		family := stemOf(products[i].Name)
		if stem != "" && family != stem {
			continue
		}
		families[family] = append(families[family], orderLine{product: &products[i], quantity: size})
	}
	if len(families) != 1 {
		return nil
	}

	var sizes []orderLine
	for _, only := range families {
		sizes = only
	}
	sort.Slice(sizes, func(a, b int) bool { return sizes[a].quantity > sizes[b].quantity })

	lines := []orderLine{}
	left := want
	for _, size := range sizes {
		if size.quantity <= 0 || left < size.quantity {
			continue
		}
		count := math.Floor(left / size.quantity)
		left -= count * size.quantity
		lines = append(lines, orderLine{product: size.product, quantity: count * quantity})
	}
	// Floating point on millilitres: 1.5 litres is 1500, not 1499.999,
	// but the division that produced it need not be.
	if left > 0.001 || len(lines) == 0 {
		return nil
	}
	return lines
}

// stemOf is a product name with its trailing size removed — "Milk 500ml"
// is "milk", and a bare "2 Lit" is "". Read off the expanded spelling so
// that "Lit" counts as a litre here exactly as it does everywhere else.
func stemOf(name string) string {
	return squash(trailingSize.ReplaceAllString(expandSize(name), ""))
}

// millilitresOf reads a volume out of a name or a file's word, in
// millilitres. Anything without one — "packet", "Paneer 200g" — is 0,
// which is what keeps this from adding up things that are not volumes.
var trailingSize = regexp.MustCompile(`(?i)(\d+(?:[.,]\d+)?)\s*(ml|l)\s*$`)

func millilitresOf(name string) float64 {
	match := trailingSize.FindStringSubmatch(expandSize(name))
	if match == nil {
		return 0
	}
	value, err := strconv.ParseFloat(strings.Replace(match[1], ",", ".", 1), 64)
	if err != nil || value <= 0 {
		return 0
	}
	if strings.EqualFold(match[2], "l") {
		return value * 1000
	}
	return value
}

func (s *Server) createImportedCustomer(r *http.Request, sess session, row importRow, products []domain.Product, rank int, route *string) (string, error) {
	// A rank beyond the band width would collide with the next priority
	// tier — see domain.Customer.RouteBand. A file that long is not a
	// round, but the guard costs nothing.
	if rank >= domain.MaxRank {
		rank = 0
	}
	customer := domain.Customer{
		ID:            domain.NewID(),
		BusinessID:    sess.Business.ID,
		Name:          strings.TrimSpace(row.Name),
		Phone:         strings.TrimSpace(row.Phone),
		Address:       strings.TrimSpace(row.Address),
		Lat:           row.Lat,
		Lng:           row.Lng,
		Notes:         strings.TrimSpace(row.Notes),
		Priority:      domain.NormalizePriority(""),
		Rank:          rank,
		ServiceAreaID: route,
		Active:        true,
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
		// One written item can be several lines — "2 Lit" against a
		// dairy that fills 1-litre bottles is two of them. See
		// resolveItem, which the preview ran over the same row.
		for _, line := range resolveItem(item.Product, item.Quantity, products) {
			order := domain.RecurringOrder{
				ID:          domain.NewID(),
				BusinessID:  sess.Business.ID,
				CustomerID:  saved.ID,
				ProductID:   line.product.ID,
				Quantity:    line.quantity,
				WeekdayMask: mask,
				StartDate:   sess.Business.Today(),
				Active:      true,
			}
			if _, err := s.store.CreateRecurringOrder(r.Context(), order); err != nil {
				// The customer exists and is useful without this line;
				// the alternative is a half-made record and a confusing
				// error.
				return saved.ID, fmt.Errorf("added, but %s could not be ordered: %w", line.product.Name, err)
			}
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
	// The same measurement, however the file spells it. A list that says
	// "0.5 L" and a catalogue that says "Milk 500ml" are talking about
	// one bottle, and so are "1000 ML" and "Milk 1L" — comparing the
	// words could never see that, because the words are different in
	// every character that matters.
	//
	// Ambiguity is refused here as it is everywhere else: with curd and
	// milk both sold by the half litre, a bare "500ml" means neither.
	if ml := millilitresOf(text); ml > 0 {
		stem := stemOf(text)
		var byVolume *domain.Product
		for i := range products {
			if math.Abs(millilitresOf(products[i].Name)-ml) > 0.001 {
				continue
			}
			if stem != "" && stemOf(products[i].Name) != stem {
				continue
			}
			if byVolume != nil {
				return nil
			}
			byVolume = &products[i]
		}
		if byVolume != nil {
			return byVolume
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
	return squash(expandSize(s))
}

// expandSize is normalizeSize without the final squash: the same volume
// spelled one way, but with its decimal point and spacing intact.
//
// Kept apart because squash removes the "." from "1.5l", which is
// harmless when the result is only ever compared to another squashed
// name and very much not harmless when something reads a number out of
// it — "1 1/2 Lit" became fifteen litres. See millilitresOf.
func expandSize(s string) string {
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
	return out
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// hasKey keeps the switch above readable now that the map holds records
// rather than a yes/no.
func hasKey(m map[string]domain.Customer, key string) bool {
	_, ok := m[key]
	return ok
}

func customerKey(name, phone string) string {
	return squash(name) + "|" + domain.NormalizePhone(phone)
}
