package auth

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"delivery-manager/internal/domain"
)

var ErrInvalidToken = errors.New("invalid token")

// Service issues and verifies this product's own JWTs. Unusually for a
// 3VNSYSTEMS product there are two ways to earn one:
//
//   - admins, via Google Sign-In (google.go), the house standard;
//   - drivers, via an admin-issued phone + PIN (pin.go).
//
// The deviation is deliberate. A delivery driver is a *staff member of a
// tenant*, not a self-service signup: their account is created by their
// employer, they may share a handset, and requiring each of them to have
// and use a Google account is the kind of friction that stops a small
// dairy adopting the product at all. Admins — who own the business record
// and the customer data — keep Google-only auth with no passwords.
type Service struct {
	secret []byte
	ttl    time.Duration
}

// Claims carries the tenant and role alongside the user, so that every
// authenticated request knows which business it is scoped to without a
// database round-trip. BusinessID being in the token is what makes
// "never trust a business_id from the request body" enforceable.
type Claims struct {
	UserID     string      `json:"user_id"`
	BusinessID string      `json:"business_id"`
	Role       domain.Role `json:"role"`
	jwt.RegisteredClaims
}

func NewService(secret string, ttl time.Duration) *Service {
	return &Service{secret: []byte(secret), ttl: ttl}
}

func (s *Service) IssueToken(user domain.User) (string, error) {
	now := time.Now().UTC()
	claims := Claims{
		UserID:     user.ID,
		BusinessID: user.BusinessID,
		Role:       user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.ttl)),
			Subject:   user.ID,
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

func (s *Service) ParseToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return s.secret, nil
	})
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}
	if claims.UserID == "" || claims.BusinessID == "" {
		return nil, ErrInvalidToken
	}
	return claims, nil
}
