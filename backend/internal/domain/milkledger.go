package domain

// Milk that moved on a day without coming out of the herd's own records.
//
// The herd's milking sheet says what the animals gave. It does not say
// what the dairy actually had to bottle, because milk moves both ways
// around it: a farm short of its own buys cans in from a neighbour or a
// collection centre, and every farm keeps some back — for the house, for
// family, for a calf that is not yet weaned. A ledger that only knew the
// herd would be wrong in both directions on an ordinary morning, and it
// would be wrong quietly, which is worse.
//
// One shape for all of it rather than a column per reason. "Bought from
// Ramesh", "sister's family" and "calves" are the same fact — some litres,
// one way or the other — and the reason is the farmer's own words in
// Note. A fixed list of reasons would be a list somebody's real reason is
// missing from.
type MilkAdjustment struct {
	ID         string `json:"id"`
	BusinessID string `json:"business_id"`
	Date       string `json:"date"`
	// Litres is always positive; Direction says which way it went. A
	// signed number would put the sign in a text box, and a minus that
	// somebody forgot to type turns "gave away two litres" into "bought
	// two litres in" without anything looking wrong.
	Litres    float64 `json:"litres"`
	Direction string  `json:"direction"`
	Note      string  `json:"note"`
}

const (
	// MilkIn is milk that arrived from outside the herd.
	MilkIn = "in"
	// MilkOut is milk that left before bottling: kept for the house,
	// given to family, fed to calves.
	MilkOut = "out"
)

// ValidMilkDirection keeps the set closed. A direction the ledger does not
// know would be added to neither side, and the day would silently not
// balance.
func ValidMilkDirection(direction string) bool {
	return direction == MilkIn || direction == MilkOut
}

// MilkLedger is one day's milk, from where it came to where it has to go.
//
// Every figure is litres. Stock is kept in bottles, and the two only meet
// through the size written in a product's name — so a product with no
// volume in its name ("Paneer 200g") is not milk to this ledger, and is
// named in Unmeasured rather than quietly left out of the sum.
type MilkLedger struct {
	Date string `json:"date"`
	// Herd is sellable milk from the animals' own records that day.
	Herd float64 `json:"herd"`
	// Withheld is milk the herd gave that cannot be sold, because the
	// animal is under a treatment with a withdrawal period. Produced, and
	// poured away — stated on its own, never inside Herd.
	Withheld float64 `json:"withheld"`
	BoughtIn float64 `json:"bought_in"`
	KeptBack float64 `json:"kept_back"`
	// Available is what there is to bottle: Herd + BoughtIn − KeptBack.
	Available float64 `json:"available"`
	// Needed is what the day's still-pending deliveries add up to.
	Needed float64 `json:"needed"`
	// Bottled is what has already been entered as stock for the day.
	Bottled     float64          `json:"bottled"`
	Adjustments []MilkAdjustment `json:"adjustments"`
	// Counted names the products measured in litres here, so a product
	// that should not be counted as milk (curd sold by the half-litre)
	// is visible rather than hidden inside a total.
	Counted    []string `json:"counted"`
	Unmeasured []string `json:"unmeasured"`
}
