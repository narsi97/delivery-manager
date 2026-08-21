package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Environment string
	Addr        string
	DatabaseURL string
	JWTSecret   string
	TokenTTL    time.Duration
	// GoogleClientID, when set, enables POST /api/v1/auth/google (admin
	// sign-in) — the OAuth 2.0 Web client ID from Google Cloud Console,
	// used as the required audience when verifying ID tokens. Left empty,
	// the endpoint returns a clear "not configured" error rather than
	// failing startup: drivers sign in with phone + PIN and don't need
	// Google configured at all, so a business can be run end-to-end on a
	// dev-login admin session before Google is wired up.
	GoogleClientID string
	AllowedOrigin  string
	// DefaultTimezone is the IANA zone new businesses get when signup
	// doesn't specify one. Every "today" in this product resolves in the
	// business's own zone (see domain.Business.Today), so this is the
	// single knob that decides when a delivery day rolls over.
	DefaultTimezone string
}

func Load() (Config, error) {
	environment, defaults := defaultsForEnvironment(lower(stringFromEnv("APP_ENV", EnvironmentLocal)))
	tokenHours := intFromEnv("TOKEN_TTL_HOURS", defaults.TokenTTLHours)

	cfg := Config{
		Environment:     environment,
		Addr:            stringFromEnv("ADDR", defaults.Addr),
		DatabaseURL:     stringFromEnv("DATABASE_URL", defaults.DatabaseURL),
		JWTSecret:       stringFromEnv("JWT_SECRET", defaults.JWTSecret),
		TokenTTL:        time.Duration(tokenHours) * time.Hour,
		GoogleClientID:  stringFromEnv("GOOGLE_CLIENT_ID", ""),
		AllowedOrigin:   stringFromEnv("ALLOWED_ORIGIN", defaults.AllowedOrigin),
		DefaultTimezone: stringFromEnv("DEFAULT_TIMEZONE", "Asia/Kolkata"),
	}

	if _, err := time.LoadLocation(cfg.DefaultTimezone); err != nil {
		return Config{}, fmt.Errorf("DEFAULT_TIMEZONE %q is not a valid IANA timezone: %w", cfg.DefaultTimezone, err)
	}

	if cfg.Environment == EnvironmentProd {
		if cfg.DatabaseURL == "" {
			return Config{}, fmt.Errorf("DATABASE_URL is required when APP_ENV=prod")
		}
		if cfg.JWTSecret == "" || cfg.JWTSecret == environmentDefaults[EnvironmentLocal].JWTSecret {
			return Config{}, fmt.Errorf("JWT_SECRET must be set to a production secret when APP_ENV=prod")
		}
	}

	return cfg, nil
}

func stringFromEnv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func intFromEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func lower(s string) string {
	out := []rune(s)
	for i, r := range out {
		if r >= 'A' && r <= 'Z' {
			out[i] = r + ('a' - 'A')
		}
	}
	return string(out)
}
