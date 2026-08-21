package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Verifies a Google "Sign in with Google" ID token server-side by fetching
// Google's public signing keys directly (JWKS), rather than pulling in
// google.golang.org/api/idtoken — that package drags in a large
// transitive dependency tree for what is, at its core, "verify an RS256
// JWT against a known JWKS endpoint",
// which golang-jwt/jwt/v5 (already a dependency here) does directly.
//
// This file is copied near-verbatim from Interest Optimizer's
// internal/auth/google.go, per the multi-product decision to standardize
// this pattern across every 3VNSYSTEMS product (see
// 3vnsystems-infrastructure/PRODUCT-PLANNING.md) so a future shared-SSO
// migration is a clean join on email, not a rewrite.

const (
	googleCertsURL      = "https://www.googleapis.com/oauth2/v3/certs"
	googleIssuerPrimary = "https://accounts.google.com"
	googleIssuerAlt     = "accounts.google.com"
	googleKeyCacheTTL   = 6 * time.Hour
)

var (
	ErrGoogleTokenInvalid = errors.New("invalid google id token")
	ErrEmailNotVerified   = errors.New("google account email is not verified")
)

// GoogleClaims is the subset of Google ID token claims this app uses.
type GoogleClaims struct {
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name,omitempty"`
	jwt.RegisteredClaims
}

type googleJWK struct {
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type googleJWKSet struct {
	Keys []googleJWK `json:"keys"`
}

// googleKeySet caches Google's public signing keys in-process, refetching
// after googleKeyCacheTTL so key rotation is picked up without a restart.
type googleKeySet struct {
	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
}

var sharedGoogleKeySet = &googleKeySet{}

func (k *googleKeySet) keyFor(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()

	if key, ok := k.keys[kid]; ok && time.Since(k.fetchedAt) < googleKeyCacheTTL {
		return key, nil
	}
	if err := k.refreshLocked(ctx); err != nil {
		return nil, err
	}
	key, ok := k.keys[kid]
	if !ok {
		return nil, fmt.Errorf("%w: unrecognized signing key", ErrGoogleTokenInvalid)
	}
	return key, nil
}

func (k *googleKeySet) refreshLocked(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, googleCertsURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("fetch google signing keys: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch google signing keys: unexpected status %d", resp.StatusCode)
	}

	var set googleJWKSet
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return fmt.Errorf("decode google signing keys: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, key := range set.Keys {
		pubKey, err := jwkToRSAPublicKey(key)
		if err != nil {
			continue
		}
		keys[key.Kid] = pubKey
	}
	k.keys = keys
	k.fetchedAt = time.Now()
	return nil
}

func jwkToRSAPublicKey(key googleJWK) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(key.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(key.E)
	if err != nil {
		return nil, err
	}
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(new(big.Int).SetBytes(eBytes).Int64()),
	}, nil
}

// VerifyGoogleIDToken validates a Google-issued ID token's signature,
// issuer, audience, and expiry, and returns its claims. audience must be
// the OAuth 2.0 Web client ID the token was issued for (GOOGLE_CLIENT_ID) —
// this is what stops a token issued for a *different* Google app from being
// replayed against this API.
func VerifyGoogleIDToken(ctx context.Context, rawToken string, audience string) (*GoogleClaims, error) {
	if strings.TrimSpace(rawToken) == "" {
		return nil, fmt.Errorf("%w: empty token", ErrGoogleTokenInvalid)
	}
	if audience == "" {
		return nil, fmt.Errorf("%w: server has no GOOGLE_CLIENT_ID configured", ErrGoogleTokenInvalid)
	}

	claims := &GoogleClaims{}
	parsed, err := jwt.ParseWithClaims(rawToken, claims, func(token *jwt.Token) (interface{}, error) {
		if token.Method.Alg() != "RS256" {
			return nil, fmt.Errorf("%w: unexpected signing method %q", ErrGoogleTokenInvalid, token.Method.Alg())
		}
		kid, _ := token.Header["kid"].(string)
		if kid == "" {
			return nil, fmt.Errorf("%w: token is missing a key id", ErrGoogleTokenInvalid)
		}
		return sharedGoogleKeySet.keyFor(ctx, kid)
	}, jwt.WithAudience(audience))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrGoogleTokenInvalid, err)
	}
	if !parsed.Valid {
		return nil, ErrGoogleTokenInvalid
	}
	if claims.Issuer != googleIssuerPrimary && claims.Issuer != googleIssuerAlt {
		return nil, fmt.Errorf("%w: unexpected issuer %q", ErrGoogleTokenInvalid, claims.Issuer)
	}
	if !claims.EmailVerified {
		return nil, ErrEmailNotVerified
	}
	claims.Email = strings.ToLower(strings.TrimSpace(claims.Email))
	if claims.Email == "" {
		return nil, fmt.Errorf("%w: token has no email claim", ErrGoogleTokenInvalid)
	}
	return claims, nil
}
