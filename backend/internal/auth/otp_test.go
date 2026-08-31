package auth

import (
	"strings"
	"testing"
)

func TestGenerateOTPIsAlwaysSixDigits(t *testing.T) {
	// Enough draws to catch a leading-zero code being trimmed to five,
	// which is roughly a 1-in-10 event per draw.
	for i := 0; i < 500; i++ {
		code, err := GenerateOTP()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(code) != OTPLength {
			t.Fatalf("code %q is %d digits, want %d", code, len(code), OTPLength)
		}
		if err := ValidateOTPFormat(code); err != nil {
			t.Fatalf("generated code %q fails its own format check: %v", code, err)
		}
	}
}

// A predictable code is not a code. This won't prove randomness, but it
// does catch the failure that matters — a constant, or a counter.
func TestGenerateOTPDoesNotRepeatItself(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		code, err := GenerateOTP()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		seen[code] = true
	}
	if len(seen) < 190 {
		t.Fatalf("only %d distinct codes in 200 draws — generation looks predictable", len(seen))
	}
}

func TestOTPHashDoesNotContainTheCode(t *testing.T) {
	code := "402913"
	hash, err := HashOTP(code)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if strings.Contains(hash, code) {
		t.Fatal("the hash contains the code in the clear")
	}
	if hash == code {
		t.Fatal("the code was stored unhashed")
	}
}

func TestCheckOTPAcceptsOnlyTheRightCode(t *testing.T) {
	hash, err := HashOTP("402913")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := CheckOTP(hash, "402913"); err != nil {
		t.Fatalf("correct code rejected: %v", err)
	}
	// Including a near miss — one digit out must be as wrong as anything.
	for _, wrong := range []string{"402914", "402912", "000000", "913402", ""} {
		if err := CheckOTP(hash, wrong); err == nil {
			t.Fatalf("code %q was accepted against a different code's hash", wrong)
		}
	}
}

func TestCheckOTPIgnoresSurroundingSpace(t *testing.T) {
	hash, _ := HashOTP("402913")
	if err := CheckOTP(hash, " 402913 "); err != nil {
		t.Fatalf("a pasted code with spaces was rejected: %v", err)
	}
}

func TestValidateOTPFormatRejectsWhatIsNotACode(t *testing.T) {
	for _, bad := range []string{"", "12345", "1234567", "40291a", "4029 1", "abcdef"} {
		if err := ValidateOTPFormat(bad); err == nil {
			t.Fatalf("%q was accepted as a code", bad)
		}
	}
	if err := ValidateOTPFormat("000000"); err != nil {
		t.Fatalf("all-zeros is a legitimate random code, got: %v", err)
	}
}
