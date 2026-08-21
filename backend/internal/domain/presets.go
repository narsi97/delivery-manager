package domain

// This file is the *entire* extent to which a business type affects
// anything. A preset is copied into a business at signup and is fully
// editable afterwards; nothing reads BusinessType again for the rest of
// that business's life.
//
// That constraint is deliberate and worth defending in review. The
// alternative — `switch businessType` inside the scheduling, routing or
// driver code — is what stops a product like this from ever serving its
// fifth vertical: every new one means auditing every branch, and every
// business that wants a small deviation from its vertical's assumptions
// has nowhere to put it. Here, "a school that also wants cash collection"
// is a config edit, not a code change, because a school's config is only
// ever a starting point.

// ProductSpec is a starter catalogue entry. Businesses rename, add to and
// deactivate these immediately; they exist so the first thing a new admin
// has to do isn't invent a product catalogue before they can record a
// single customer.
type ProductSpec struct {
	Name string
	Unit string
}

// Preset is a vertical's starting point: what to call things, what extra
// information that vertical usually needs, and what the driver usually
// has to record at the door.
type Preset struct {
	Config   BusinessConfig
	Products []ProductSpec
}

// PresetFor returns the starting configuration for a vertical. Unknown or
// empty types fall through to the generic preset rather than erroring —
// a business that doesn't fit a listed vertical is a normal case, not a
// failure.
func PresetFor(businessType BusinessType) Preset {
	switch businessType {
	case BusinessTypeDairy:
		return dairyPreset()
	case BusinessTypeSchool:
		return schoolPreset()
	case BusinessTypeWater:
		return waterPreset()
	case BusinessTypeGrocery:
		return groceryPreset()
	default:
		return genericPreset()
	}
}

// A dairy is the plainest case and the one the core model was shaped
// around: quantities of a product, delivered to a door, on a repeating
// weekly pattern. It needs no vocabulary changes and nothing captured
// beyond the outcome itself.
func dairyPreset() Preset {
	return Preset{
		Config: BusinessConfig{}.WithDefaults(),
		Products: []ProductSpec{
			{Name: "Milk 500ml", Unit: "packet"},
			{Name: "Milk 1L", Unit: "packet"},
			{Name: "Curd 500g", Unit: "tub"},
		},
	}
}

// A school run is the useful stress test of the "no branching" rule: it
// looks like a different product, and yet it decomposes into exactly the
// same core. A student is a customer with a pinned pickup point; a
// morning pickup is a product; "on the bus today" is a delivery whose
// quantity is one seat. Everything a school genuinely needs beyond that —
// which class, which guardian, who the child was handed to — is a custom
// field or a capture, not a new table.
func schoolPreset() Preset {
	config := BusinessConfig{
		Terminology: Terminology{
			Customer:       "Student",
			CustomerPlural: "Students",
			Delivery:       "Trip",
			DeliveryPlural: "Trips",
			Product:        "Service",
			ProductPlural:  "Services",
			Quantity:       "Seats",
			Route:          "Run",
			Driver:         "Driver",
		},
		CustomFields: []FieldSpec{
			{Key: "class", Label: "Class", Type: FieldText, AppliesTo: TargetCustomer},
			{Key: "guardian_name", Label: "Guardian", Type: FieldText, Required: true, AppliesTo: TargetCustomer},
			{
				Key:       "guardian_phone",
				Label:     "Guardian phone",
				Type:      FieldPhone,
				Required:  true,
				AppliesTo: TargetCustomer,
				Hint:      "Called first if the student isn't at the pickup point.",
			},
		},
		StopCaptures: []CaptureSpec{
			{
				Key:      "handed_to",
				Label:    "Handed to",
				Type:     FieldText,
				Required: true,
				OnStatus: []DeliveryStatus{StatusDelivered},
				Hint:     "Who received the student — a guardian's name, or the school gate.",
			},
			{
				Key:      "absence_reason",
				Label:    "Why not collected",
				Type:     FieldText,
				Required: true,
				OnStatus: []DeliveryStatus{StatusFailed},
			},
		},
	}
	return Preset{
		Config: config.WithDefaults(),
		Products: []ProductSpec{
			{Name: "Morning pickup", Unit: "trip"},
			{Name: "Afternoon drop", Unit: "trip"},
		},
	}
}

// Water delivery is a dairy round with one extra beat: the driver takes
// empties away. That is a capture, not a feature flag — the count varies
// per stop and needs recording per stop.
func waterPreset() Preset {
	config := BusinessConfig{
		StopCaptures: []CaptureSpec{
			{
				Key:      "cans_returned",
				Label:    "Empty cans collected",
				Type:     FieldNumber,
				OnStatus: []DeliveryStatus{StatusDelivered},
			},
		},
	}
	return Preset{
		Config:   config.WithDefaults(),
		Products: []ProductSpec{{Name: "Water can 20L", Unit: "can"}},
	}
}

func groceryPreset() Preset {
	return Preset{
		Config:   BusinessConfig{}.WithDefaults(),
		Products: []ProductSpec{{Name: "Grocery order", Unit: "bag"}},
	}
}

func genericPreset() Preset {
	return Preset{
		Config:   BusinessConfig{}.WithDefaults(),
		Products: []ProductSpec{{Name: "Delivery", Unit: "unit"}},
	}
}
