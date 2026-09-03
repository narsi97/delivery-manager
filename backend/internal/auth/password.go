package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// Passwords, for the deployment that has no SMS provider.
//
// The product is built around a one-time code sent to a phone, which is
// the right answer for a workforce that changes and a business that
// should never be storing anybody's password. It is also the answer that
// cannot be delivered until somebody signs up with an SMS provider and
// registers a DLT template — see internal/notify.
//
// So there is a second door: the same phone number, and a password the
// business chooses. It exists to get one real customer running, and it
// is a genuine trade-off, not a better idea:
//
//   - a password is something to forget, and the reset path is a human
//     asking the business owner, because there is no channel to send a
//     reset link down either;
//   - the owner sets their drivers' first password, so it travels by
//     word of mouth and is very often never changed.
//
// The one-time code path is left in place and working, so wiring a
// provider later is a config change rather than a migration.

// MinPasswordLength is short because the people typing it are drivers on
// phones at five in the morning, and a rule that pushes them towards
// writing it on the van is not security. The real protection here is
// that the app is not on the public internet by name — see the
// deployment notes.
const MinPasswordLength = 6

// MaxPasswordLength keeps bcrypt's 72-byte input limit from silently
// truncating: two different long passwords that share a prefix would
// otherwise both work.
const MaxPasswordLength = 72

var ErrWrongPassword = errors.New("wrong password")

// ValidatePassword reports whether this is something we will store.
func ValidatePassword(password string) error {
	if strings.TrimSpace(password) == "" {
		return fmt.Errorf("a password is required")
	}
	if utf8.RuneCountInString(password) < MinPasswordLength {
		return fmt.Errorf("a password needs at least %d characters", MinPasswordLength)
	}
	if len(password) > MaxPasswordLength {
		return fmt.Errorf("that password is too long — %d characters at most", MaxPasswordLength)
	}
	return nil
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// CheckPassword compares a typed password against the stored hash.
//
// An account with no password set never matches, rather than matching
// everything: bcrypt rejects the empty hash, but relying on that would
// be one refactor away from a very bad afternoon.
func CheckPassword(hash, password string) error {
	if strings.TrimSpace(hash) == "" {
		return ErrWrongPassword
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return ErrWrongPassword
	}
	return nil
}
