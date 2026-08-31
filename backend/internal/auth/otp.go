package auth

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// One-time codes, for both the business owner signing up or coming back
// after a long absence, and the driver signing in each time.
//
// A 6-digit code is a million wide, which is nothing — so, exactly as
// with the PIN this replaces, the safety is in the controls around it
// rather than the code itself:
//
//   - it lives for OTPExpiry and no longer;
//   - it can be wrong at most OTPMaxAttempts times before it is burned,
//     so an attacker gets 5 guesses out of a million, not unlimited;
//   - it is single-use — verifying consumes it, so a code read over
//     someone's shoulder is worthless the moment it is used;
//   - it is bcrypt-hashed at rest, so a database leak doesn't hand over
//     live codes for numbers that are mid-sign-in;
//   - requesting one is rate-limited per phone number, so it can't be
//     used to spam someone's handset or to run up an SMS bill.
//
// Generated with crypto/rand, not math/rand: a predictable code is not a
// code. This is the one place in this codebase where that distinction
// actually matters.
const (
	OTPLength      = 6
	OTPExpiry      = 5 * time.Minute
	OTPMaxAttempts = 5
)

var (
	ErrOTPFormat    = fmt.Errorf("code must be exactly %d digits", OTPLength)
	ErrOTPInvalid   = errors.New("that code is not right")
	ErrOTPExpired   = errors.New("that code has expired")
	ErrOTPExhausted = errors.New("too many wrong attempts on this code")
)

// GenerateOTP returns a fresh code as a zero-padded decimal string.
// Zero-padded on purpose: trimming a leading zero would quietly make some
// codes 5 digits and break a fixed-length input on the phone.
func GenerateOTP() (string, error) {
	max := big.NewInt(1)
	for i := 0; i < OTPLength; i++ {
		max.Mul(max, big.NewInt(10))
	}
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", OTPLength, n), nil
}

// HashOTP is bcrypt at the default cost. Deliberately the same treatment
// a password gets, even though the code lives five minutes: the window
// where a leak matters is small, but it is not zero, and "it expires
// soon" is not a reason to store a live credential in the clear.
func HashOTP(code string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// ValidateOTPFormat checks shape only — never whether a code is correct.
// Kept separate so the handler can reject obviously malformed input
// without touching the database or burning an attempt.
func ValidateOTPFormat(code string) error {
	code = strings.TrimSpace(code)
	if len(code) != OTPLength {
		return ErrOTPFormat
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return ErrOTPFormat
		}
	}
	return nil
}

// CheckOTP compares a submitted code against the stored hash. bcrypt's
// comparison is constant-time with respect to the hash, so this does not
// leak how much of the code was right.
func CheckOTP(hash, code string) error {
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(strings.TrimSpace(code))); err != nil {
		return ErrOTPInvalid
	}
	return nil
}
