package httpapi

import (
	"context"
	"errors"
	"log"
	"strings"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/domain"
	"delivery-manager/internal/storage"
)

// Creating the first account, when nobody can sign up.
//
// Self-serve signup is off while the product is being shaped around one
// business (see passwordauth.go), which leaves an obvious hole: a fresh
// deployment would have no accounts and no way to make one. This fills
// it from configuration — the owner's number and first password come
// from the environment, once, at startup.
//
// It is deliberately a no-op unless the account is genuinely missing.
// Running it on every boot means a restart can never quietly reset a
// password somebody has since changed, and never creates a second
// business beside the real one.
func (s *Server) BootstrapOwner(ctx context.Context, businessName, phone, password, ownerName string) error {
	phone = domain.NormalizePhone(phone)
	if phone == "" || strings.TrimSpace(password) == "" || strings.TrimSpace(businessName) == "" {
		return nil // nothing configured; an existing deployment is untouched
	}
	if err := auth.ValidatePassword(password); err != nil {
		return err
	}

	if existing, err := s.store.GetUserByPhone(ctx, phone); err == nil {
		log.Printf("bootstrap: %s already has an account (%s) — leaving it alone", phone, existing.ID)
		return nil
	} else if !errors.Is(err, storage.ErrNotFound) {
		return err
	}

	if strings.TrimSpace(ownerName) == "" {
		ownerName = "Owner"
	}
	business, owner, err := s.createBusinessWithOwnerPhone(
		ctx, strings.TrimSpace(businessName), domain.BusinessTypeDairy, s.defaultTimezone, phone, ownerName)
	if err != nil {
		return err
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	if err := s.store.SetUserPassword(ctx, business.ID, owner.ID, hash); err != nil {
		return err
	}

	log.Printf("bootstrap: created %s with owner %s (%s)", business.Name, owner.Name, phone)
	return nil
}
