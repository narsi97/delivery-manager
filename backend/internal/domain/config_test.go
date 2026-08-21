package domain

import "testing"

func customerSpecs() []FieldSpec {
	return []FieldSpec{
		{Key: "class", Label: "Class", Type: FieldText, AppliesTo: TargetCustomer},
		{Key: "guardian_phone", Label: "Guardian phone", Type: FieldPhone, Required: true, AppliesTo: TargetCustomer},
		{Key: "siblings", Label: "Siblings", Type: FieldNumber, AppliesTo: TargetCustomer},
		{Key: "prepaid", Label: "Prepaid", Type: FieldBoolean, AppliesTo: TargetCustomer},
		{Key: "invoice_ref", Label: "Invoice ref", Type: FieldText, AppliesTo: TargetDailyOrder},
	}
}

func TestValidateFieldValuesAcceptsDeclaredValues(t *testing.T) {
	cleaned, err := ValidateFieldValues(customerSpecs(), TargetCustomer, FieldValues{
		"class":          "4B",
		"guardian_phone": "+91 98765 43210",
		"siblings":       float64(2),
		"prepaid":        true,
	})
	if err != nil {
		t.Fatalf("ValidateFieldValues: %v", err)
	}

	if cleaned["class"] != "4B" {
		t.Errorf("class = %v, want 4B", cleaned["class"])
	}
	// Phone fields normalize on the way in, exactly like a driver's login
	// number, so the same person entered two ways matches later.
	if cleaned["guardian_phone"] != "9876543210" {
		t.Errorf("guardian_phone = %v, want the normalized number", cleaned["guardian_phone"])
	}
	if cleaned["siblings"] != float64(2) {
		t.Errorf("siblings = %v, want 2", cleaned["siblings"])
	}
	if cleaned["prepaid"] != true {
		t.Errorf("prepaid = %v, want true", cleaned["prepaid"])
	}
}

// Web forms submit everything as a string. Refusing "2" for a number
// field would be a validation error with no upside.
func TestValidateFieldValuesCoercesFormStrings(t *testing.T) {
	cleaned, err := ValidateFieldValues(customerSpecs(), TargetCustomer, FieldValues{
		"guardian_phone": "9876543210",
		"siblings":       "2",
		"prepaid":        "true",
	})
	if err != nil {
		t.Fatalf("ValidateFieldValues: %v", err)
	}
	if cleaned["siblings"] != float64(2) {
		t.Errorf("siblings = %#v, want the number 2", cleaned["siblings"])
	}
	if cleaned["prepaid"] != true {
		t.Errorf("prepaid = %#v, want the boolean true", cleaned["prepaid"])
	}
}

// The single most important rule for a JSONB bag: only declared keys get
// stored, or it becomes a landfill nobody can safely clean up.
func TestValidateFieldValuesRejectsUndeclaredKeys(t *testing.T) {
	_, err := ValidateFieldValues(customerSpecs(), TargetCustomer, FieldValues{
		"guardian_phone": "9876543210",
		"favourite_food": "dosa",
	})
	if err == nil {
		t.Fatal("an undeclared key was accepted")
	}
}

// Fields are scoped to the record they hang off: a daily-order field must
// not be settable on a customer.
func TestValidateFieldValuesRespectsTarget(t *testing.T) {
	_, err := ValidateFieldValues(customerSpecs(), TargetCustomer, FieldValues{
		"guardian_phone": "9876543210",
		"invoice_ref":    "INV-1",
	})
	if err == nil {
		t.Fatal("a daily_order field was accepted on a customer")
	}

	if _, err := ValidateFieldValues(customerSpecs(), TargetDailyOrder, FieldValues{"invoice_ref": "INV-1"}); err != nil {
		t.Fatalf("a daily_order field was rejected on a daily order: %v", err)
	}
}

func TestValidateFieldValuesEnforcesRequired(t *testing.T) {
	if _, err := ValidateFieldValues(customerSpecs(), TargetCustomer, FieldValues{"class": "4B"}); err == nil {
		t.Fatal("a missing required field was accepted")
	}

	// Blank is the same as missing — an empty text input must not satisfy
	// a required field.
	if _, err := ValidateFieldValues(customerSpecs(), TargetCustomer, FieldValues{"guardian_phone": "   "}); err == nil {
		t.Fatal("a blank required field was accepted")
	}
}

func TestValidateFieldValuesRejectsUnparseableValues(t *testing.T) {
	specs := customerSpecs()
	if _, err := ValidateFieldValues(specs, TargetCustomer, FieldValues{"guardian_phone": "9876543210", "siblings": "many"}); err == nil {
		t.Fatal("a non-numeric value was accepted for a number field")
	}
	if _, err := ValidateFieldValues(specs, TargetCustomer, FieldValues{"guardian_phone": "9876543210", "prepaid": "sort of"}); err == nil {
		t.Fatal("a non-boolean value was accepted for a boolean field")
	}
}

func schoolCaptures() []CaptureSpec {
	return []CaptureSpec{
		{Key: "handed_to", Label: "Handed to", Type: FieldText, Required: true, OnStatus: []DeliveryStatus{StatusDelivered}},
		{Key: "absence_reason", Label: "Why not collected", Type: FieldText, Required: true, OnStatus: []DeliveryStatus{StatusFailed}},
		{Key: "minutes_late", Label: "Minutes late", Type: FieldNumber},
	}
}

// A capture required on delivery must not be demanded on a failure, and
// vice versa — otherwise a driver can't report what actually happened.
func TestValidateCapturesAppliesPerOutcome(t *testing.T) {
	delivered, err := ValidateCaptures(schoolCaptures(), StatusDelivered, FieldValues{"handed_to": "Mother"})
	if err != nil {
		t.Fatalf("a valid delivery capture was rejected: %v", err)
	}
	if delivered["handed_to"] != "Mother" {
		t.Errorf("handed_to = %v, want Mother", delivered["handed_to"])
	}

	if _, err := ValidateCaptures(schoolCaptures(), StatusDelivered, FieldValues{}); err == nil {
		t.Fatal("a delivery was closed without its required capture")
	}

	failed, err := ValidateCaptures(schoolCaptures(), StatusFailed, FieldValues{"absence_reason": "Not at the gate"})
	if err != nil {
		t.Fatalf("a valid failure capture was rejected: %v", err)
	}
	if failed["absence_reason"] != "Not at the gate" {
		t.Errorf("absence_reason = %v", failed["absence_reason"])
	}

	// The delivery-only capture must not be demanded on a failure.
	if _, err := ValidateCaptures(schoolCaptures(), StatusFailed, FieldValues{"absence_reason": "Not at the gate"}); err != nil {
		t.Fatalf("a failure was blocked by a delivery-only capture: %v", err)
	}
}

// A capture with no OnStatus applies to every outcome the driver can
// report.
func TestValidateCapturesUngatedAppliesEverywhere(t *testing.T) {
	for _, status := range []DeliveryStatus{StatusDelivered, StatusFailed} {
		values := FieldValues{"minutes_late": "5"}
		if status == StatusDelivered {
			values["handed_to"] = "Mother"
		} else {
			values["absence_reason"] = "Absent"
		}

		cleaned, err := ValidateCaptures(schoolCaptures(), status, values)
		if err != nil {
			t.Fatalf("%s: %v", status, err)
		}
		if cleaned["minutes_late"] != float64(5) {
			t.Errorf("%s: minutes_late = %#v, want 5", status, cleaned["minutes_late"])
		}
	}
}

// A stale field left on screen by an app that hasn't refreshed its config
// must not block the driver from reporting what happened.
func TestValidateCapturesDropsInapplicableValuesInsteadOfFailing(t *testing.T) {
	cleaned, err := ValidateCaptures(schoolCaptures(), StatusFailed, FieldValues{
		"absence_reason": "Absent",
		"handed_to":      "stale value from the previous screen",
	})
	if err != nil {
		t.Fatalf("an inapplicable capture blocked the report: %v", err)
	}
	if _, present := cleaned["handed_to"]; present {
		t.Error("an inapplicable capture was stored")
	}
}

func TestConfigValidateRejectsBadDeclarations(t *testing.T) {
	cases := map[string]BusinessConfig{
		"empty key": {CustomFields: []FieldSpec{{Key: "", Type: FieldText, AppliesTo: TargetCustomer}}},
		"key with spaces": {
			CustomFields: []FieldSpec{{Key: "guardian phone", Type: FieldText, AppliesTo: TargetCustomer}},
		},
		"key starting with a digit": {
			CustomFields: []FieldSpec{{Key: "1st_guardian", Type: FieldText, AppliesTo: TargetCustomer}},
		},
		"unknown type": {
			CustomFields: []FieldSpec{{Key: "birthday", Type: FieldType("date"), AppliesTo: TargetCustomer}},
		},
		"unknown target": {
			CustomFields: []FieldSpec{{Key: "thing", Type: FieldText, AppliesTo: FieldTarget("route")}},
		},
		"duplicate field on one target": {
			CustomFields: []FieldSpec{
				{Key: "class", Type: FieldText, AppliesTo: TargetCustomer},
				{Key: "class", Type: FieldText, AppliesTo: TargetCustomer},
			},
		},
		"duplicate capture": {
			StopCaptures: []CaptureSpec{{Key: "handed_to", Type: FieldText}, {Key: "handed_to", Type: FieldText}},
		},
		"capture gated on an outcome a driver can't report": {
			StopCaptures: []CaptureSpec{{Key: "handed_to", Type: FieldText, OnStatus: []DeliveryStatus{StatusSkipped}}},
		},
	}

	for name, config := range cases {
		t.Run(name, func(t *testing.T) {
			if err := config.Validate(); err == nil {
				t.Fatal("invalid config was accepted")
			}
		})
	}
}

// The same key on two different records is legitimate — they're stored
// on different rows and can't be confused.
func TestConfigValidateAllowsSameKeyOnDifferentTargets(t *testing.T) {
	config := BusinessConfig{
		CustomFields: []FieldSpec{
			{Key: "reference", Type: FieldText, AppliesTo: TargetCustomer},
			{Key: "reference", Type: FieldText, AppliesTo: TargetDailyOrder},
		},
	}
	if err := config.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestWithDefaultsFillsTerminologyAndNeverReturnsNilSlices(t *testing.T) {
	config := BusinessConfig{}.WithDefaults()

	if config.Terminology.Customer == "" || config.Terminology.DeliveryPlural == "" {
		t.Fatalf("terminology was left blank: %+v", config.Terminology)
	}
	if config.CustomFields == nil || config.StopCaptures == nil {
		t.Fatal("WithDefaults returned nil slices, which serialize as null instead of []")
	}

	// An explicit override must survive.
	custom := BusinessConfig{Terminology: Terminology{Customer: "Student"}}.WithDefaults()
	if custom.Terminology.Customer != "Student" {
		t.Errorf("Customer = %q, want Student", custom.Terminology.Customer)
	}
	if custom.Terminology.CustomerPlural != "Customers" {
		t.Errorf("CustomerPlural = %q, want the default to fill in", custom.Terminology.CustomerPlural)
	}
}

// Every shipped preset has to be one a business could actually have
// saved — otherwise signup writes a config the config editor would refuse.
func TestEveryPresetIsValidAndComplete(t *testing.T) {
	types := []BusinessType{
		BusinessTypeDairy, BusinessTypeSchool, BusinessTypeGrocery,
		BusinessTypeWater, BusinessTypeOther, BusinessType("something-new"),
	}

	for _, businessType := range types {
		t.Run(string(businessType), func(t *testing.T) {
			preset := PresetFor(businessType)

			if err := preset.Config.Validate(); err != nil {
				t.Fatalf("preset config is invalid: %v", err)
			}
			if preset.Config.Terminology.Customer == "" {
				t.Error("preset has blank terminology")
			}
			if len(preset.Products) == 0 {
				t.Error("preset seeds no products, so a new business can't record anything")
			}
			for _, product := range preset.Products {
				if product.Name == "" {
					t.Error("preset seeds a product with no name")
				}
			}
		})
	}
}

func TestSchoolPresetRenamesNounsAndDeclaresItsFields(t *testing.T) {
	config := PresetFor(BusinessTypeSchool).Config

	if config.Terminology.Customer != "Student" {
		t.Errorf("school customers are called %q, want Student", config.Terminology.Customer)
	}

	guardian := false
	for _, spec := range config.CustomFields {
		if spec.Key == "guardian_phone" && spec.Type == FieldPhone && spec.Required {
			guardian = true
		}
	}
	if !guardian {
		t.Error("school preset doesn't require a guardian phone")
	}

	handedTo := false
	for _, spec := range config.StopCaptures {
		if spec.Key == "handed_to" && spec.Required && spec.AppliesOn(StatusDelivered) && !spec.AppliesOn(StatusFailed) {
			handedTo = true
		}
	}
	if !handedTo {
		t.Error("school preset doesn't require 'handed to' on a completed drop")
	}
}

// The dairy is the baseline: it must not inherit any vertical-specific
// friction, or the simplest case pays for the complicated ones.
func TestDairyPresetAddsNoRequiredCeremony(t *testing.T) {
	config := PresetFor(BusinessTypeDairy).Config

	if len(config.CustomFields) != 0 {
		t.Errorf("dairy preset declares custom fields: %+v", config.CustomFields)
	}
	if len(config.StopCaptures) != 0 {
		t.Errorf("dairy preset declares stop captures: %+v", config.StopCaptures)
	}
	if config.Terminology.Customer != "Customer" {
		t.Errorf("dairy renames the customer to %q", config.Terminology.Customer)
	}
}
