package domain

import (
	"fmt"
	"strconv"
	"strings"
)

// BusinessConfig is per-tenant configuration: the layer that lets one
// codebase serve a dairy, a school bus operator and a water supplier
// without any of them appearing as a branch in the delivery engine.
//
// The rule this type exists to enforce: **BusinessType is seed data, not
// behaviour.** A vertical is a named set of defaults (see PresetFor) that
// is copied into a business's config at signup and is editable from that
// moment on. Nothing downstream may ask "is this a school?" — it asks the
// config what to call things, what extra fields exist, and what the
// driver must capture. That is the difference between adding the fifth
// vertical in an afternoon and adding it by grepping for `case "school"`.
//
// Stored as a single JSONB column rather than a table per concern.
// Config is read on essentially every request (it comes back with the
// session) and written by hand a few times in a business's life; it is
// small, always fetched whole, and never queried across tenants. A blob
// is the honest shape for that. The cost is no per-key constraints in the
// database, which Validate compensates for at the one write path.
type BusinessConfig struct {
	Terminology Terminology `json:"terminology"`
	// CustomFields declare extra data this business keeps on its
	// customers or its individual deliveries — a student's class and
	// guardian, a gate code, an invoice reference. Declared here and
	// stored in the matching record's custom_fields, so adding one is a
	// config edit rather than a migration.
	CustomFields []FieldSpec `json:"custom_fields"`
	// StopCaptures declare what a driver must record to close a stop
	// beyond "delivered"/"failed" — who a child was handed to, how many
	// empty cans came back, how much cash was collected.
	StopCaptures []CaptureSpec `json:"stop_captures"`
	// Extensions names bespoke per-tenant logic this business opts into.
	// Nothing reads it yet — it is the declared seam for layer 4 (see
	// Docs/ARCHITECTURE.md). It lives here from day one so that turning a
	// bespoke request on later is a config change, not a schema change.
	Extensions []string `json:"extensions,omitempty"`
}

// Terminology renames the core nouns for a vertical. A school operator
// manages students on runs, not customers on delivery routes, and being
// forced to read "customer" all day is exactly the friction that makes a
// generic product feel like it wasn't built for you.
//
// These are labels only. Renaming a customer to a student changes not one
// line of routing, scheduling or persistence.
type Terminology struct {
	Customer       string `json:"customer"`
	CustomerPlural string `json:"customer_plural"`
	Delivery       string `json:"delivery"`
	DeliveryPlural string `json:"delivery_plural"`
	Product        string `json:"product"`
	ProductPlural  string `json:"product_plural"`
	Quantity       string `json:"quantity"`
	Route          string `json:"route"`
	Driver         string `json:"driver"`
}

// FieldType is the small set of value shapes a custom field may take.
// Deliberately small: every one of these round-trips through JSON, renders
// as an obvious input, and validates in a couple of lines. Richer types
// (dates, enumerations, file uploads) are additions to make when a real
// business needs one, not speculative surface.
type FieldType string

const (
	FieldText    FieldType = "text"
	FieldNumber  FieldType = "number"
	FieldBoolean FieldType = "boolean"
	FieldPhone   FieldType = "phone"
)

func (f FieldType) valid() bool {
	switch f {
	case FieldText, FieldNumber, FieldBoolean, FieldPhone:
		return true
	}
	return false
}

// FieldTarget is which record a custom field hangs off.
type FieldTarget string

const (
	// TargetCustomer is durable information about the person — a
	// student's class, a gate code.
	TargetCustomer FieldTarget = "customer"
	// TargetDailyOrder is information about one date's delivery — an
	// invoice number, a note that today is prepaid.
	TargetDailyOrder FieldTarget = "daily_order"
)

func (t FieldTarget) valid() bool {
	return t == TargetCustomer || t == TargetDailyOrder
}

type FieldSpec struct {
	Key       string      `json:"key"`
	Label     string      `json:"label"`
	Type      FieldType   `json:"type"`
	Required  bool        `json:"required"`
	AppliesTo FieldTarget `json:"applies_to"`
	// Hint is shown under the input in the admin console.
	Hint string `json:"hint,omitempty"`
}

// CaptureSpec is a FieldSpec for the doorstep: something the driver has
// to supply when reporting an outcome.
//
// OnStatus limits when it is demanded. A "reason it failed" capture that
// was required on every successful delivery would be nonsense, and a
// "handed to" capture is meaningless on a failure. Empty means "on any
// outcome the driver can report".
type CaptureSpec struct {
	Key      string           `json:"key"`
	Label    string           `json:"label"`
	Type     FieldType        `json:"type"`
	Required bool             `json:"required"`
	OnStatus []DeliveryStatus `json:"on_status,omitempty"`
	Hint     string           `json:"hint,omitempty"`
}

// AppliesOn reports whether this capture is demanded for a given outcome.
func (c CaptureSpec) AppliesOn(status DeliveryStatus) bool {
	if len(c.OnStatus) == 0 {
		return true
	}
	for _, s := range c.OnStatus {
		if s == status {
			return true
		}
	}
	return false
}

// FieldValues is the stored side of a custom field or a capture: an
// untyped bag validated against its declared spec on the way in.
//
// Values are stored as-declared (a number stays a JSON number) rather
// than stringified, so that a later reporting feature can aggregate them
// without having to guess how to parse each one back.
type FieldValues map[string]any

// ValidateFieldValues checks submitted values against the specs declared
// for a target, returning a cleaned map containing only declared keys.
//
// Unknown keys are rejected rather than silently stored. A JSONB bag that
// accepts anything becomes a landfill within a year — typo'd keys, values
// from a half-finished feature, data nobody can safely delete because
// nobody knows what writes it. Rejecting at the boundary keeps what's on
// disk equal to what's declared.
func ValidateFieldValues(specs []FieldSpec, target FieldTarget, values FieldValues) (FieldValues, error) {
	declared := map[string]FieldSpec{}
	for _, spec := range specs {
		if spec.AppliesTo == target {
			declared[spec.Key] = spec
		}
	}

	cleaned := FieldValues{}
	for key, raw := range values {
		spec, ok := declared[key]
		if !ok {
			return nil, fmt.Errorf("%q is not a field this business has set up", key)
		}
		coerced, err := coerceValue(spec.Type, raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", labelOr(spec.Label, spec.Key), err)
		}
		if coerced != nil {
			cleaned[key] = coerced
		}
	}

	for key, spec := range declared {
		if !spec.Required {
			continue
		}
		if _, present := cleaned[key]; !present {
			return nil, fmt.Errorf("%s is required", labelOr(spec.Label, spec.Key))
		}
	}
	return cleaned, nil
}

// ValidateCaptures is ValidateFieldValues for the doorstep, filtered to
// the captures that apply to the outcome the driver is reporting.
func ValidateCaptures(specs []CaptureSpec, status DeliveryStatus, values FieldValues) (FieldValues, error) {
	declared := map[string]CaptureSpec{}
	for _, spec := range specs {
		if spec.AppliesOn(status) {
			declared[spec.Key] = spec
		}
	}

	cleaned := FieldValues{}
	for key, raw := range values {
		spec, ok := declared[key]
		if !ok {
			// A capture submitted for the wrong outcome (a "handed to"
			// on a failed stop) is dropped rather than refused: the
			// driver's report of what happened is the important part and
			// must not be blocked by a stale field the app still showed.
			continue
		}
		coerced, err := coerceValue(spec.Type, raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", labelOr(spec.Label, spec.Key), err)
		}
		if coerced != nil {
			cleaned[key] = coerced
		}
	}

	for key, spec := range declared {
		if !spec.Required {
			continue
		}
		if _, present := cleaned[key]; !present {
			return nil, fmt.Errorf("%s is required before this stop can be closed", labelOr(spec.Label, spec.Key))
		}
	}
	return cleaned, nil
}

// coerceValue normalizes a JSON-decoded value to its declared type,
// returning nil for "the user left this blank". It accepts a number sent
// as a string (and vice versa) because form inputs on the web produce
// strings for everything, and refusing "3" for a number field would be a
// pointlessly hostile validation error.
func coerceValue(fieldType FieldType, raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}

	switch fieldType {
	case FieldText, FieldPhone:
		text, ok := raw.(string)
		if !ok {
			text = fmt.Sprintf("%v", raw)
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return nil, nil
		}
		if fieldType == FieldPhone {
			return NormalizePhone(text), nil
		}
		return text, nil

	case FieldNumber:
		switch value := raw.(type) {
		case float64:
			return value, nil
		case string:
			trimmed := strings.TrimSpace(value)
			if trimmed == "" {
				return nil, nil
			}
			parsed, err := strconv.ParseFloat(trimmed, 64)
			if err != nil {
				return nil, fmt.Errorf("must be a number")
			}
			return parsed, nil
		default:
			return nil, fmt.Errorf("must be a number")
		}

	case FieldBoolean:
		switch value := raw.(type) {
		case bool:
			return value, nil
		case string:
			trimmed := strings.TrimSpace(value)
			if trimmed == "" {
				return nil, nil
			}
			parsed, err := strconv.ParseBool(trimmed)
			if err != nil {
				return nil, fmt.Errorf("must be yes or no")
			}
			return parsed, nil
		default:
			return nil, fmt.Errorf("must be yes or no")
		}
	}

	return nil, fmt.Errorf("has an unsupported field type %q", fieldType)
}

func labelOr(label, key string) string {
	if strings.TrimSpace(label) != "" {
		return label
	}
	return key
}

// Validate checks a config an admin is trying to save. It is the only
// place config correctness is enforced, since the database holds it as an
// opaque blob.
func (c BusinessConfig) Validate() error {
	const maxSpecs = 25

	if len(c.CustomFields) > maxSpecs {
		return fmt.Errorf("a business can declare at most %d custom fields", maxSpecs)
	}
	if len(c.StopCaptures) > maxSpecs {
		return fmt.Errorf("a business can declare at most %d stop captures", maxSpecs)
	}

	seenFields := map[string]bool{}
	for _, spec := range c.CustomFields {
		key := strings.TrimSpace(spec.Key)
		if err := validKey(key); err != nil {
			return fmt.Errorf("custom field %q: %w", spec.Key, err)
		}
		// Keys are unique per target, not globally: a customer and a
		// delivery may each carry a "reference" without ambiguity,
		// because they are stored on different records.
		scoped := string(spec.AppliesTo) + "." + key
		if seenFields[scoped] {
			return fmt.Errorf("custom field %q is declared twice for %s", key, spec.AppliesTo)
		}
		seenFields[scoped] = true

		if !spec.Type.valid() {
			return fmt.Errorf("custom field %q has an unsupported type %q", key, spec.Type)
		}
		if !spec.AppliesTo.valid() {
			return fmt.Errorf("custom field %q must apply to %q or %q", key, TargetCustomer, TargetDailyOrder)
		}
	}

	seenCaptures := map[string]bool{}
	for _, spec := range c.StopCaptures {
		key := strings.TrimSpace(spec.Key)
		if err := validKey(key); err != nil {
			return fmt.Errorf("stop capture %q: %w", spec.Key, err)
		}
		if seenCaptures[key] {
			return fmt.Errorf("stop capture %q is declared twice", key)
		}
		seenCaptures[key] = true

		if !spec.Type.valid() {
			return fmt.Errorf("stop capture %q has an unsupported type %q", key, spec.Type)
		}
		for _, status := range spec.OnStatus {
			// Only outcomes a driver can actually report are meaningful
			// here; a capture gated on "pending" would never be asked for.
			if status != StatusDelivered && status != StatusFailed {
				return fmt.Errorf("stop capture %q can only apply to delivered or failed", key)
			}
		}
	}

	return nil
}

// validKey constrains custom-field keys to something safe to use as a
// JSON key, a form field name and, eventually, a report column heading.
func validKey(key string) error {
	if key == "" {
		return fmt.Errorf("needs a key")
	}
	if len(key) > 40 {
		return fmt.Errorf("key is too long (max 40 characters)")
	}
	for i, r := range key {
		isLower := r >= 'a' && r <= 'z'
		isDigit := r >= '0' && r <= '9'
		if isLower || (isDigit && i > 0) || (r == '_' && i > 0) {
			continue
		}
		return fmt.Errorf("key must be lowercase letters, digits and underscores, starting with a letter")
	}
	return nil
}

// WithDefaults fills in anything an admin left blank, so that a partially
// specified config (or one saved before a field existed) never renders a
// screen full of empty labels.
func (c BusinessConfig) WithDefaults() BusinessConfig {
	fallback := defaultTerminology()
	if c.Terminology.Customer == "" {
		c.Terminology.Customer = fallback.Customer
	}
	if c.Terminology.CustomerPlural == "" {
		c.Terminology.CustomerPlural = fallback.CustomerPlural
	}
	if c.Terminology.Delivery == "" {
		c.Terminology.Delivery = fallback.Delivery
	}
	if c.Terminology.DeliveryPlural == "" {
		c.Terminology.DeliveryPlural = fallback.DeliveryPlural
	}
	if c.Terminology.Product == "" {
		c.Terminology.Product = fallback.Product
	}
	if c.Terminology.ProductPlural == "" {
		c.Terminology.ProductPlural = fallback.ProductPlural
	}
	if c.Terminology.Quantity == "" {
		c.Terminology.Quantity = fallback.Quantity
	}
	if c.Terminology.Route == "" {
		c.Terminology.Route = fallback.Route
	}
	if c.Terminology.Driver == "" {
		c.Terminology.Driver = fallback.Driver
	}
	if c.CustomFields == nil {
		c.CustomFields = []FieldSpec{}
	}
	if c.StopCaptures == nil {
		c.StopCaptures = []CaptureSpec{}
	}
	return c
}

func defaultTerminology() Terminology {
	return Terminology{
		Customer:       "Customer",
		CustomerPlural: "Customers",
		Delivery:       "Delivery",
		DeliveryPlural: "Deliveries",
		Product:        "Product",
		ProductPlural:  "Products",
		Quantity:       "Quantity",
		Route:          "Route",
		Driver:         "Driver",
	}
}
