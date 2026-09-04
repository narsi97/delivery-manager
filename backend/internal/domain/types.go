package domain

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

// The core abstraction this product is built around (see Docs/DESIGN.md):
//
//	Business -> Customers -> Recurring Orders -> Daily Orders -> Routes -> Drivers
//
// Nothing dairy-specific lives in these types. A milk round, a school bus
// run, and a water-can delivery all reduce to "a customer at a pinned
// location expects some quantity of some product on some days", which is
// what keeps one codebase serving every vertical.

// BusinessType is descriptive, not behavioural: it drives seeded default
// products and frontend wording, never branching in the delivery engine.
// Hard-coding per-vertical logic into the core is the thing this product
// is specifically trying to avoid.
type BusinessType string

const (
	BusinessTypeDairy   BusinessType = "dairy"
	BusinessTypeSchool  BusinessType = "school"
	BusinessTypeGrocery BusinessType = "grocery"
	BusinessTypeWater   BusinessType = "water"
	BusinessTypeOther   BusinessType = "other"
)

func ValidBusinessType(t BusinessType) bool {
	switch t {
	case BusinessTypeDairy, BusinessTypeSchool, BusinessTypeGrocery, BusinessTypeWater, BusinessTypeOther:
		return true
	}
	return false
}

type Business struct {
	ID   string       `json:"id"`
	Name string       `json:"name"`
	Type BusinessType `json:"business_type"`
	// Timezone is an IANA name (e.g. "Asia/Kolkata"). Every "today" in
	// this product is resolved in the *business's* zone, not the server's
	// or the caller's — a 6am milk round must roll over to the next day
	// on the round's own clock, whichever machine happens to answer the
	// request. See Today().
	Timezone  string    `json:"timezone"`
	CreatedAt time.Time `json:"created_at"`
	// Config is this tenant's configuration — vocabulary, custom fields,
	// what the driver must capture. Seeded from the vertical's preset at
	// signup (see PresetFor) and editable forever after. It travels with
	// the session so the frontend can render the right labels and forms
	// without a second request.
	Config BusinessConfig `json:"config"`
	// HomeLat/HomeLng is where the business itself is based — the depot,
	// the shop, the dairy. Distinct from a ServiceArea: this is one point
	// a business always has, used to pre-fill "where does the round
	// start" and to scope every map's default view instead of opening on
	// an India-wide view. Zero value means unset, same convention as
	// Customer.Lat/Lng — see HasHome.
	HomeLat float64 `json:"home_lat"`
	HomeLng float64 `json:"home_lng"`
}

// HasHome reports whether this business has set its own location. Mirrors
// Customer.HasPin — the exact 0,0 pair is treated as "unset" rather than a
// real location (Null Island, Gulf of Guinea, never a real depot).
func (b Business) HasHome() bool { return b.HomeLat != 0 || b.HomeLng != 0 }

// Today returns the current date in the business's own timezone as
// YYYY-MM-DD. Falls back to UTC if the zone name doesn't resolve, rather
// than erroring — a bad timezone string should degrade the date by hours,
// not take the whole day's route offline.
func (b Business) Today() string {
	loc, err := time.LoadLocation(b.Timezone)
	if err != nil {
		loc = time.UTC
	}
	return time.Now().In(loc).Format(DateLayout)
}

// DateLayout is the wire and storage format for delivery dates. Dates are
// deliberately plain strings, not time.Time: a delivery date is a calendar
// day in the business's zone, and round-tripping it through an instant
// invites off-by-one-day bugs at midnight boundaries.
const DateLayout = "2006-01-02"

// Role covers the "owner drives their own van" case explicitly. A small
// dairy is frequently one person who is both the admin and the only
// driver, so RoleAdminDriver is a first-class role rather than something
// simulated by creating two accounts for one human.
type Role string

const (
	RoleAdmin       Role = "admin"
	RoleDriver      Role = "driver"
	RoleAdminDriver Role = "admin_driver"
)

func (r Role) CanAdmin() bool { return r == RoleAdmin || r == RoleAdminDriver }
func (r Role) CanDrive() bool { return r == RoleDriver || r == RoleAdminDriver }
func (r Role) IsValid() bool  { return r.CanAdmin() || r.CanDrive() }

type User struct {
	ID         string `json:"id"`
	BusinessID string `json:"business_id"`
	Role       Role   `json:"role"`
	Name       string `json:"name"`
	// Email is set for admins, who sign in with Google (the 3VNSYSTEMS
	// house standard — see PRODUCT-PLANNING.md). Phone is set for
	// drivers, who sign in with an admin-issued phone + PIN instead: a
	// delivery driver can't be assumed to have, or want to use, a Google
	// account on a shared work handset. Exactly one of the two is the
	// account's sign-in identity; both may be present for contact
	// purposes.
	Email  string `json:"email,omitempty"`
	Phone  string `json:"phone,omitempty"`
	Active bool   `json:"active"`
	// HomeLat/HomeLng is where this driver finishes their day. A round
	// ends when the driver gets home, not when they get back to the
	// depot, and that changes which stop should be last: the cheapest
	// order to end in Ramgiri is not the cheapest order to end back at
	// the dairy. Zero means unset — see HasHome.
	HomeLat float64 `json:"home_lat"`
	HomeLng float64 `json:"home_lng"`
	// FinishAt is where this driver's round ends — see the type. Empty
	// means the farm, which is both the default and what a driver who
	// predates this setting was effectively already doing whenever they
	// had no home pinned.
	FinishAt  FinishAt `json:"finish_at"`
	FinishLat float64  `json:"finish_lat"`
	FinishLng float64  `json:"finish_lng"`
	// MaxStops is how many deliveries this driver can carry in one round
	// — a property of their van, not of today, which is why it lives here
	// and not on a route. Zero means no limit, and is the default.
	//
	// It has to be stored rather than passed in with a split, because
	// rounds re-prepare themselves on every read of the day (see
	// ensureDayRounds): a limit the server didn't remember would be
	// undone by the next page load.
	MaxStops  int       `json:"max_stops"`
	CreatedAt time.Time `json:"created_at"`
}

// HasHome reports whether this user has somewhere to finish. Mirrors
// Customer.HasPin and Business.HasHome — exact 0,0 is treated as unset
// rather than as Null Island.
func (u User) HasHome() bool { return u.HomeLat != 0 || u.HomeLng != 0 }

// FinishAt is where a driver's route ends.
//
// The obvious answer was "their home", and it was wrong for the actual
// business. A driver usually goes back to the farm at the end: undelivered
// stock has to be handed over and the empty bottles have to be returned,
// and neither can happen at the driver's house. Sometimes it genuinely is
// home, and sometimes it is neither — a second collection point, a
// relative's shop.
//
// So it is a choice per driver rather than an assumption, and the default
// is the farm, because that is what most rounds actually do.
type FinishAt string

const (
	// FinishAtFarm sends the driver back to the business's own location —
	// the default, and the only one that lets stock and empties come back.
	FinishAtFarm FinishAt = "farm"
	// FinishAtHome ends the round wherever the driver lives.
	FinishAtHome FinishAt = "home"
	// FinishAtCustom ends it at a pin set on this driver, for a round
	// that hands over somewhere that is neither.
	FinishAtCustom FinishAt = "custom"
)

func ValidFinishAt(f FinishAt) bool {
	switch f {
	case FinishAtFarm, FinishAtHome, FinishAtCustom, "":
		return true
	}
	return false
}

func NormalizeFinishAt(f FinishAt) FinishAt {
	if f == FinishAtHome || f == FinishAtCustom {
		return f
	}
	return FinishAtFarm
}

// FinishPoint resolves where this driver's route should end, given the
// business they work for. Returns ok=false when the choice cannot be
// honoured — home selected with no home pinned, custom selected with no
// custom pin — in which case the route is left open-ended rather than
// being sent to 0,0 in the Gulf of Guinea.
func (u User) FinishPoint(b Business) (lat float64, lng float64, ok bool) {
	switch NormalizeFinishAt(u.FinishAt) {
	case FinishAtHome:
		if u.HasHome() {
			return u.HomeLat, u.HomeLng, true
		}
	case FinishAtCustom:
		if u.FinishLat != 0 || u.FinishLng != 0 {
			return u.FinishLat, u.FinishLng, true
		}
	default:
		if b.HasHome() {
			return b.HomeLat, b.HomeLng, true
		}
	}
	return 0, 0, false
}

// Customer is deliberately account-less by default. Admins onboard real
// customers long before those customers ever get an app, so AccountID is
// nullable and stays nil for the entire V1 — the phase-2 customer app
// claims an existing record by setting it, rather than needing a parallel
// "customer" table to migrate into.
type Customer struct {
	ID         string `json:"id"`
	BusinessID string `json:"business_id"`
	Name       string `json:"name"`
	Phone      string `json:"phone"`
	Address    string `json:"address"`
	// Lat/Lng are the delivery pin, and they are the source of truth for
	// routing — not Address. Rural and semi-urban addresses geocode
	// badly or not at all, so the admin drops a pin (or captures the
	// driver's current GPS while standing at the door) and the text
	// address is only ever shown to a human.
	Lat   float64 `json:"lat"`
	Lng   float64 `json:"lng"`
	Notes string  `json:"notes"`
	// Priority decides who gets visited first, ahead of what the shortest
	// path would say. A shop that opens at six and a household whose
	// children leave for school are not "a stop like any other", and a
	// route that is optimal in kilometres but arrives after the child has
	// gone is not optimal at all. See PriorityTier.
	Priority PriorityTier `json:"priority"`
	// Rank is the admin's own visiting order, 1-based within a priority
	// tier. Zero means they never said, which is where every customer
	// starts.
	//
	// Priority says which group somebody belongs to; Rank says where
	// they sit inside it. A dairy driving the same streets in the same
	// order every morning has an order in their head that no
	// shortest-path calculation can know about, and this is where it
	// goes. See RouteBand.
	Rank int `json:"rank"`
	// ServiceAreaID pins this customer to one service route by hand. Nil
	// means "work it out from the pin", which is how every customer
	// starts and how most of them stay.
	//
	// Geography alone cannot answer "morning or evening": two customers
	// on the same street can be on different rounds, and no circle drawn
	// on a map separates them. So a service route claims customers by
	// their pin *and* accepts them by name, and two routes are allowed
	// to cover exactly the same ground. See areaForCustomer in httpapi,
	// which is where that resolution happens.
	ServiceAreaID *string   `json:"service_area_id"`
	AccountID     *string   `json:"account_id"`
	Active        bool      `json:"active"`
	CreatedAt     time.Time `json:"created_at"`
	// CustomFields holds whatever extra information this business
	// declared it keeps about a customer — a student's class and
	// guardian, a gate code. Validated against the declared specs on the
	// way in (see ValidateFieldValues), so it can only ever contain keys
	// the business actually set up.
	CustomFields FieldValues `json:"custom_fields,omitempty"`
}

// rankSpan is how much room each priority tier gets for hand-ordered
// customers. Bigger than any real customer list, so a ranked customer in
// one tier can never collide with a ranked customer in the next.
const rankSpan = 10000

// MaxRank is the highest hand-set position a customer can hold before it
// would spill into the next priority tier's band. Exported so callers
// that assign ranks in bulk — importing a numbered delivery list, say —
// can check the same limit RouteBand enforces.
const MaxRank = rankSpan - 1

// RouteBand is the band this customer's stops are ordered in — see
// route.OptimizePrioritised. The tier decides the broad group; within
// it, a hand-ranked customer gets a band of their own (so the order the
// admin dragged is the order driven) and everyone unranked shares the
// last band in the tier, where the shortest path still decides.
//
// That is what keeps hand-ordering from quietly costing a business its
// route optimization: order the six stops you care about and the other
// ninety-four are routed exactly as they were.
func (c Customer) RouteBand() int {
	tier := c.Priority.Rank() * rankSpan
	if c.Rank > 0 && c.Rank < rankSpan-1 {
		return tier + c.Rank
	}
	return tier + rankSpan - 1
}

// HasPin reports whether this customer can be routed. A customer with no
// pin is still a valid record (admin captured the details, hasn't been to
// the door yet) — they just get skipped by route building instead of
// being routed to 0,0 in the Gulf of Guinea.
func (c Customer) HasPin() bool { return c.Lat != 0 || c.Lng != 0 }

// ServiceArea is a named delivery zone a business declares — a city or
// locality it delivers to, as a center pin and a radius. It exists so
// every map in the app can default to a sane zoomed-in view instead of an
// India-wide one, and so customers and today's stops can be grouped by
// which zone they fall in for one-click route building. Circle+radius,
// not a polygon — the same "the pin is the address" simplicity Customer
// already uses, not a shape editor nobody asked for.
//
// Only ever created and edited through the admin HTTP API, so — like
// Customer — it has no Validate() of its own; validation lives at the one
// write path in internal/httpapi.
type ServiceArea struct {
	ID           string    `json:"id"`
	BusinessID   string    `json:"business_id"`
	Name         string    `json:"name"`
	Lat          float64   `json:"lat"`
	Lng          float64   `json:"lng"`
	RadiusMeters float64   `json:"radius_meters"`
	Active       bool      `json:"active"`
	CreatedAt    time.Time `json:"created_at"`
}

// OTPChallenge is a sign-in or sign-up in progress: someone has asked
// for a code, and it has not been used yet.
//
// Keyed by phone, one live challenge per number — asking for a new code
// replaces the old one rather than leaving several valid at once, which
// is both what a person expects when they press "resend" and one fewer
// live credential per number.
//
// The signup fields carry what was typed *before* the number was proven,
// so the business is only created once the code comes back correct. That
// ordering matters: it means an unverified phone number can never leave
// a business record behind.
type OTPChallenge struct {
	Phone     string    `json:"phone"`
	CodeHash  string    `json:"-"`
	Purpose   string    `json:"purpose"`
	Attempts  int       `json:"attempts"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`

	// Set for Purpose == OTPPurposeSignup only.
	BusinessName string       `json:"business_name,omitempty"`
	BusinessType BusinessType `json:"business_type,omitempty"`
	OwnerName    string       `json:"owner_name,omitempty"`
}

const (
	OTPPurposeSignup = "signup"
	OTPPurposeSignIn = "signin"
)

// Expired reports whether this challenge is past its life. Checked
// before the code is compared, so an expired code is never "wrong" —
// it is expired, which is a different thing to tell someone.
func (c OTPChallenge) Expired(now time.Time) bool { return now.After(c.ExpiresAt) }

// Checkin is a driver's start of day: they have reached the farm, counted
// what they are taking, and are waiting to be let go.
//
// The point is not the count — it is that somebody at the farm agrees
// with the count before a van leaves with stock in it. A driver who
// loads 38 packets and delivers 40 addresses discovers the problem two
// streets from the end; the same driver whose 38 was checked against the
// list discovers it while still standing next to more milk.
//
// So the day's stops stay hidden until this is approved. That gate is
// the whole feature; the number is just what there is to agree about.
type Checkin struct {
	ID         string        `json:"id"`
	BusinessID string        `json:"business_id"`
	DriverID   string        `json:"driver_id"`
	RouteDate  string        `json:"route_date"`
	Units      int           `json:"units"`
	Note       string        `json:"note"`
	Status     CheckinStatus `json:"status"`
	// Who approved or rejected it, and what they said. An admin rejecting
	// a count owes the driver a reason — "12 short" is actionable, a bare
	// rejection is not.
	ReviewedBy string     `json:"reviewed_by,omitempty"`
	ReviewNote string     `json:"review_note,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	ReviewedAt *time.Time `json:"reviewed_at,omitempty"`
}

type CheckinStatus string

const (
	// CheckinPending: the driver has reported and is waiting.
	CheckinPending CheckinStatus = "pending"
	// CheckinApproved: the round is unlocked for that driver, that day.
	CheckinApproved CheckinStatus = "approved"
	// CheckinRejected: the count was wrong. The driver can report again —
	// a rejection is a correction, not a lockout.
	CheckinRejected CheckinStatus = "rejected"
)

func (c Checkin) Approved() bool { return c.Status == CheckinApproved }

// PriorityTier is how much a customer's position in the route is worth
// bending the path for.
//
// Deliberately three coarse buckets rather than a number or a time. A
// number invites an admin to invent a scale nobody else understands; a
// time promises the route will *meet* it, which needs vehicle routing
// with time windows and can be infeasible — the honest version of that
// promise is a warning the app cannot currently make. Buckets say what
// the business already says out loud: shops first, school families next,
// everyone else after.
type PriorityTier string

const (
	// PriorityBusiness is a shop, hotel or canteen — somewhere that opens
	// at a fixed hour and cannot take the milk late.
	PriorityBusiness PriorityTier = "business"
	// PriorityEarly is a household that needs delivery before the day
	// starts, most often because children leave for school.
	PriorityEarly PriorityTier = "early"
	// PriorityNormal is everyone else, and the default.
	PriorityNormal PriorityTier = "normal"
)

// Rank orders the tiers for sorting. Lower goes first.
func (p PriorityTier) Rank() int {
	switch p {
	case PriorityBusiness:
		return 0
	case PriorityEarly:
		return 1
	default:
		return 2
	}
}

func ValidPriority(p PriorityTier) bool {
	switch p {
	case PriorityBusiness, PriorityEarly, PriorityNormal, "":
		return true
	}
	return false
}

// NormalizePriority turns an empty or unknown value into the default, so
// a customer created before priorities existed sorts as normal rather
// than as an unrecognised tier.
func NormalizePriority(p PriorityTier) PriorityTier {
	if p == PriorityBusiness || p == PriorityEarly {
		return p
	}
	return PriorityNormal
}

type Product struct {
	ID         string `json:"id"`
	BusinessID string `json:"business_id"`
	Name       string `json:"name"`
	// Unit is a display label ("L", "packet", "can", "trip"). Quantity
	// arithmetic never interprets it.
	Unit       string `json:"unit"`
	PriceCents int    `json:"price_cents"`
	// StockQuantity is what the business has on hand, in Unit. Kept as a
	// number the admin sets rather than one the app decrements on every
	// delivery: a dairy counts what is in the cold room, and a tally that
	// silently drifts the first time something is spilled, given away or
	// delivered off the books is worse than no tally at all.
	StockQuantity float64 `json:"stock_quantity"`
	Active        bool    `json:"active"`
}

// RecurringOrder is the standing subscription ("2L of milk, Mon-Fri").
// It is emphatically NOT the daily task: daily tasks are generated from
// it, so that a one-off change to Thursday never has to mutate — and risk
// corrupting — the customer's standing arrangement.
type RecurringOrder struct {
	ID         string  `json:"id"`
	BusinessID string  `json:"business_id"`
	CustomerID string  `json:"customer_id"`
	ProductID  string  `json:"product_id"`
	Quantity   float64 `json:"quantity"`
	// WeekdayMask is a 7-bit set, bit 0 = Sunday .. bit 6 = Saturday.
	// A mask (rather than a child table of weekdays) keeps "does this
	// subscription run today?" a single integer test in every store
	// implementation and in SQL.
	WeekdayMask int    `json:"weekday_mask"`
	StartDate   string `json:"start_date"`
	// EndDate empty means open-ended.
	EndDate   string    `json:"end_date,omitempty"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
}

// RunsOn reports whether this subscription should produce a delivery on
// the given YYYY-MM-DD date, accounting for the weekday mask and the
// start/end window. Inactive subscriptions never run.
func (r RecurringOrder) RunsOn(date string) bool {
	if !r.Active {
		return false
	}
	day, err := time.Parse(DateLayout, date)
	if err != nil {
		return false
	}
	if r.StartDate != "" && date < r.StartDate {
		return false
	}
	if r.EndDate != "" && date > r.EndDate {
		return false
	}
	return r.WeekdayMask&(1<<uint(day.Weekday())) != 0
}

// WeekdaysFromMask expands a mask into 0..6 weekday numbers, for wire
// formats that are friendlier to a UI than a bitfield.
func WeekdaysFromMask(mask int) []int {
	days := []int{}
	for d := 0; d < 7; d++ {
		if mask&(1<<uint(d)) != 0 {
			days = append(days, d)
		}
	}
	return days
}

func MaskFromWeekdays(days []int) int {
	mask := 0
	for _, d := range days {
		if d >= 0 && d <= 6 {
			mask |= 1 << uint(d)
		}
	}
	return mask
}

type DeliveryStatus string

const (
	StatusPending   DeliveryStatus = "pending"
	StatusDelivered DeliveryStatus = "delivered"
	StatusFailed    DeliveryStatus = "failed"
	// StatusSkipped is an admin/customer decision made in advance ("on
	// vacation"), which is a different thing from StatusFailed ("driver
	// went, nobody answered"). Conflating them would make the daily
	// numbers useless: skips are expected and free, failures are a
	// problem someone has to chase.
	StatusSkipped DeliveryStatus = "skipped"
)

func ValidDeliveryStatus(s DeliveryStatus) bool {
	switch s {
	case StatusPending, StatusDelivered, StatusFailed, StatusSkipped:
		return true
	}
	return false
}

// DailyOrder is one concrete task on one date — the unit a driver acts on
// and the unit a date-specific override edits. BaseQuantity preserves what
// the subscription *said* alongside the Quantity actually being delivered,
// so "4L instead of the usual 2L" is legible after the fact without
// re-deriving it from the subscription (which may since have changed).
type DailyOrder struct {
	ID               string         `json:"id"`
	BusinessID       string         `json:"business_id"`
	CustomerID       string         `json:"customer_id"`
	ProductID        string         `json:"product_id"`
	RecurringOrderID *string        `json:"recurring_order_id"`
	DeliveryDate     string         `json:"delivery_date"`
	Quantity         float64        `json:"quantity"`
	BaseQuantity     float64        `json:"base_quantity"`
	Status           DeliveryStatus `json:"status"`
	// OverrideReason is set only when Quantity has been moved away from
	// BaseQuantity (or the order skipped) for this date.
	OverrideReason string  `json:"override_reason,omitempty"`
	Note           string  `json:"note,omitempty"`
	RouteID        *string `json:"route_id"`
	// Sequence is the stop's position within its route, 1-based. Zero
	// means "not yet sequenced into a route".
	Sequence    int        `json:"sequence"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	// CustomFields is per-delivery extra data an admin recorded.
	CustomFields FieldValues `json:"custom_fields,omitempty"`
	// Captures is what the driver recorded at the door, keyed by the
	// business's declared CaptureSpecs. Kept separate from CustomFields
	// because the two answer different questions — one is what the office
	// planned, the other is what happened — and a billing or dispute
	// query wants exactly one of them.
	Captures FieldValues `json:"captures,omitempty"`
}

// IsOverridden reports whether an admin (later: the customer) has moved
// this date away from the standing arrangement.
func (d DailyOrder) IsOverridden() bool {
	return d.Status == StatusSkipped || d.Quantity != d.BaseQuantity
}

// Open reports whether the stop still needs the driver to do something.
func (d DailyOrder) Open() bool { return d.Status == StatusPending }

type RouteStatus string

const (
	RouteDraft      RouteStatus = "draft"
	RouteAssigned   RouteStatus = "assigned"
	RouteInProgress RouteStatus = "in_progress"
	RouteCompleted  RouteStatus = "completed"
)

type Route struct {
	ID         string      `json:"id"`
	BusinessID string      `json:"business_id"`
	RouteDate  string      `json:"route_date"`
	Name       string      `json:"name"`
	DriverID   *string     `json:"driver_id"`
	Status     RouteStatus `json:"status"`
	// ServiceAreaID is the service route this one was prepared for.
	//
	// It used to be worked out from StartLat/StartLng, which was fine
	// while every service route sat somewhere different. It stopped
	// being fine the moment two of them could cover the same streets: a
	// morning and an evening route share a centre exactly, so the
	// coordinates cannot tell them apart and whichever sorted first won
	// both. Nil on routes prepared before this existed, and on one-off
	// routes that belong to no service route at all — callers fall back
	// to the geographic guess for those.
	ServiceAreaID *string `json:"service_area_id"`
	// StartLat/StartLng is where the round begins — the dairy, the depot,
	// the school. Stop ordering is only meaningful relative to a start
	// point, so it's stored with the route rather than recomputed.
	StartLat float64 `json:"start_lat"`
	StartLng float64 `json:"start_lng"`
	// EndLat/EndLng is where the round finishes, when that is somewhere
	// in particular — set from the assigned driver's home. Zero leaves
	// the round open-ended, which is what every route was before drivers
	// had homes: the last stop is wherever the optimizer left it, and
	// the drive afterwards costs nothing because nobody said where it
	// goes. See HasEnd.
	EndLat float64 `json:"end_lat"`
	EndLng float64 `json:"end_lng"`
	// ManualOrder records that a human has arranged this route by hand.
	//
	// Once set, the optimizer stops rearranging it: a stop added later is
	// appended rather than slotted in by distance. Without this, an admin
	// who moves a stop to the front loses that the moment anything else
	// changes, which reads as the app ignoring them. Rebuilding the route
	// from its options clears it deliberately.
	ManualOrder bool `json:"manual_order"`
	// EstimatedMeters is straight-line distance across the ordered stops,
	// not road distance — V1 has no routing-API dependency (see
	// internal/route). It is a comparison aid ("this ordering is better
	// than that one"), never an ETA promise to a customer.
	EstimatedMeters float64   `json:"estimated_meters"`
	CreatedAt       time.Time `json:"created_at"`
}

// HasEnd reports whether this route finishes somewhere specific.
func (r Route) HasEnd() bool { return r.EndLat != 0 || r.EndLng != 0 }

// Stop is a read model: a DailyOrder joined with the customer and product
// a driver needs to actually complete it. Drivers get one payload with
// everything for the doorstep, rather than N+1 lookups over a phone
// connection that may be poor.
type Stop struct {
	DailyOrder
	CustomerName    string  `json:"customer_name"`
	CustomerPhone   string  `json:"customer_phone"`
	CustomerAddress string  `json:"customer_address"`
	CustomerNotes   string  `json:"customer_notes,omitempty"`
	Lat             float64 `json:"lat"`
	Lng             float64 `json:"lng"`
	ProductName     string  `json:"product_name"`
	ProductUnit     string  `json:"product_unit"`
	// CustomerFields is the customer's custom_fields, surfaced on the
	// stop so a driver has the guardian's phone number at the door
	// without a second lookup on a bad connection.
	CustomerFields FieldValues `json:"customer_fields,omitempty"`
}

// DeliveryEvent is the append-only audit trail of what happened to a stop
// and who did it. Kept separate from DailyOrder.Status (which is only the
// current state) because "who marked this failed, and when" is exactly the
// question a business asks when a customer complains they got nothing.
type DeliveryEvent struct {
	ID           string         `json:"id"`
	BusinessID   string         `json:"business_id"`
	DailyOrderID string         `json:"daily_order_id"`
	ActorUserID  string         `json:"actor_user_id"`
	Status       DeliveryStatus `json:"status"`
	Note         string         `json:"note,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
}

// NewID generates an opaque, unguessable record ID. Random rather than
// sequential on purpose: IDs appear in URLs a driver's phone hits, and
// sequential IDs would leak customer counts across tenants.
func NewID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failing is not a recoverable application condition;
		// a time-based fallback keeps the process alive rather than
		// panicking mid-request.
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}

// NormalizePhone reduces a phone number to a canonical key so that
// "+91 98765 43210", "919876543210", "098765 43210" and "9876543210" all
// resolve to the same driver. Without this, an admin who saves a number
// with a country code locks out a driver who types it without one — and
// the driver has no way to discover why.
//
// The rule is: keep digits only, then keep the last 10 of them. Ten is
// the national subscriber-number length in India (the first market),
// the US, and most of the countries this would plausibly ship to next.
//
// The trade-off, stated plainly: two numbers in different countries that
// share their last ten digits collide. At the scale this product
// operates at — a handful of small businesses with a handful of drivers
// each — that is vanishingly unlikely, and it fails *loudly* (a 409 when
// an admin tries to add the second driver) rather than silently letting
// the wrong person in. The fix when it ever matters is to store an
// explicit country/dial code per business and normalize against it,
// which is a change to this one function plus a backfill.
// ValidPhone reports whether a number, once normalized, is a usable
// subscriber number. Sits next to NormalizePhone deliberately: the two
// have to agree about what a phone number *is*, and an auth package
// growing its own second opinion is how a lookup silently stops matching
// the row it wrote.
func ValidPhone(phone string) bool {
	return len(NormalizePhone(phone)) == 10
}

func NormalizePhone(phone string) string {
	var digits strings.Builder
	for _, r := range phone {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}

	national := digits.String()
	const subscriberDigits = 10
	if len(national) > subscriberDigits {
		national = national[len(national)-subscriberDigits:]
	}
	return national
}
