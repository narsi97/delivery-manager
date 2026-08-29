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
	Email     string    `json:"email,omitempty"`
	Phone     string    `json:"phone,omitempty"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
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
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Notes     string    `json:"notes"`
	AccountID *string   `json:"account_id"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
	// CustomFields holds whatever extra information this business
	// declared it keeps about a customer — a student's class and
	// guardian, a gate code. Validated against the declared specs on the
	// way in (see ValidateFieldValues), so it can only ever contain keys
	// the business actually set up.
	CustomFields FieldValues `json:"custom_fields,omitempty"`
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
	// StartLat/StartLng is where the round begins — the dairy, the depot,
	// the school. Stop ordering is only meaningful relative to a start
	// point, so it's stored with the route rather than recomputed.
	StartLat float64 `json:"start_lat"`
	StartLng float64 `json:"start_lng"`
	// EstimatedMeters is straight-line distance across the ordered stops,
	// not road distance — V1 has no routing-API dependency (see
	// internal/route). It is a comparison aid ("this ordering is better
	// than that one"), never an ETA promise to a customer.
	EstimatedMeters float64   `json:"estimated_meters"`
	CreatedAt       time.Time `json:"created_at"`
}

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
