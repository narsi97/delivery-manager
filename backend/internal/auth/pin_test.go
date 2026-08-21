package auth

import "testing"

func TestValidatePINRejectsBadFormats(t *testing.T) {
	cases := map[string]string{
		"too short":     "12345",
		"too long":      "1234567",
		"empty":         "",
		"letters":       "12a456",
		"symbols":       "12-456",
		"unicode digit": "12٣456",
	}
	for name, pin := range cases {
		if err := ValidatePIN(pin); err == nil {
			t.Errorf("%s: ValidatePIN(%q) = nil, want a format error", name, pin)
		}
	}
}

// The guessable-PIN rules exist because the search space is only a
// million wide; these are the values a thief tries first.
func TestValidatePINRejectsGuessablePINs(t *testing.T) {
	for _, pin := range []string{"000000", "111111", "999999", "123456", "234567", "654321", "987654"} {
		if err := ValidatePIN(pin); err != ErrWeakPIN {
			t.Errorf("ValidatePIN(%q) = %v, want ErrWeakPIN", pin, err)
		}
	}
}

func TestValidatePINAcceptsOrdinaryPINs(t *testing.T) {
	for _, pin := range []string{"481920", "100200", "907316", "112233"} {
		if err := ValidatePIN(pin); err != nil {
			t.Errorf("ValidatePIN(%q) = %v, want nil", pin, err)
		}
	}
}

func TestHashAndCheckPINRoundTrip(t *testing.T) {
	const pin = "481920"

	hash, err := HashPIN(pin)
	if err != nil {
		t.Fatalf("HashPIN: %v", err)
	}
	if hash == pin {
		t.Fatal("HashPIN returned the PIN itself — it must be hashed at rest")
	}
	if err := CheckPIN(hash, pin); err != nil {
		t.Fatalf("CheckPIN with the correct PIN = %v, want nil", err)
	}
	if err := CheckPIN(hash, "481921"); err != ErrPINInvalid {
		t.Fatalf("CheckPIN with a wrong PIN = %v, want ErrPINInvalid", err)
	}
}

// A driver row with no PIN set must never authenticate. Returning a
// generic ErrPINInvalid (rather than a distinct "no pin" error) keeps a
// caller from writing `if err == ErrNoPIN { allow }` by accident.
func TestCheckPINRejectsEmptyAndMalformedHashes(t *testing.T) {
	if err := CheckPIN("", "481920"); err != ErrPINInvalid {
		t.Fatalf("CheckPIN with no stored hash = %v, want ErrPINInvalid", err)
	}
	if err := CheckPIN("not-a-bcrypt-hash", "481920"); err != ErrPINInvalid {
		t.Fatalf("CheckPIN with a malformed hash = %v, want ErrPINInvalid", err)
	}
}

// HashPIN is the only path that writes a credential, so it must apply the
// same rules as ValidatePIN rather than trusting its caller to have done so.
func TestHashPINRefusesInvalidPINs(t *testing.T) {
	if _, err := HashPIN("123456"); err != ErrWeakPIN {
		t.Fatalf("HashPIN(sequence) = %v, want ErrWeakPIN", err)
	}
	if _, err := HashPIN("12"); err == nil {
		t.Fatal("HashPIN(short) = nil error, want a format error")
	}
}
