package auth

import (
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// PINLength is fixed at 6 digits. A PIN is a low-entropy secret by
// design — it has to be typed one-handed at 5am — so its safety comes
// from the surrounding controls, not its length: it is bcrypt-hashed at
// rest, it is rate-limited per phone number on the login path (see
// httpapi's driver login limiter), and it only ever unlocks one driver's
// own route for one business.
const PINLength = 6

var (
	ErrWeakPIN    = errors.New("pin is too easy to guess")
	ErrPINFormat  = fmt.Errorf("pin must be exactly %d digits", PINLength)
	ErrPINInvalid = errors.New("incorrect pin")
)

// ValidatePIN enforces the format and rejects the small set of PINs that
// are, in practice, the first things anyone tries. Blocking sequences and
// repeated digits removes the overwhelming majority of real-world guesses
// at essentially no usability cost, which matters more here than for a
// password because the search space is only a million wide to begin with.
func ValidatePIN(pin string) error {
	pin = strings.TrimSpace(pin)
	if len(pin) != PINLength {
		return ErrPINFormat
	}
	for _, r := range pin {
		if r < '0' || r > '9' {
			return ErrPINFormat
		}
	}

	allSame := true
	ascending := true
	descending := true
	for i := 1; i < len(pin); i++ {
		if pin[i] != pin[0] {
			allSame = false
		}
		if pin[i] != pin[i-1]+1 {
			ascending = false
		}
		if pin[i] != pin[i-1]-1 {
			descending = false
		}
	}
	if allSame || ascending || descending {
		return ErrWeakPIN
	}
	return nil
}

// HashPIN returns a bcrypt hash to store. bcrypt's default cost is used
// rather than something higher: driver login happens on the critical
// morning path from a phone, and the deliberate slowness that protects a
// stolen *password* database matters less than it usually would when the
// underlying secret is six digits anyway.
func HashPIN(pin string) (string, error) {
	if err := ValidatePIN(pin); err != nil {
		return "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(strings.TrimSpace(pin)), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// CheckPIN compares a submitted PIN against a stored hash. It returns
// ErrPINInvalid for every failure mode — wrong PIN, malformed hash, no
// hash stored — so a caller can't accidentally turn "this driver has no
// PIN set" into a successful login.
func CheckPIN(hash string, pin string) error {
	if hash == "" {
		return ErrPINInvalid
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(strings.TrimSpace(pin))); err != nil {
		return ErrPINInvalid
	}
	return nil
}
