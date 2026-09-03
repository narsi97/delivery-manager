package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment string
	Addr        string
	DatabaseURL string
	JWTSecret   string
	TokenTTL    time.Duration
	// GoogleClientID is retained only so an existing deployment's env
	// file doesn't become invalid overnight. Nothing reads it since
	// sign-in became phone + OTP for everyone (see httpapi/otpauth.go).
	GoogleClientID string
	// AllowLogOTPSender permits the development OTP sender — which
	// writes codes to the server log instead of texting them — to run
	// under APP_ENV=prod. Off by default and deliberately awkward to
	// turn on: with it enabled, anyone who can read the logs can sign in
	// as anyone. It exists because this product is currently deployed as
	// a private demo with no SMS provider; it must come off in the same
	// change that wires a real one.
	AllowLogOTPSender bool
	// OTPSignInDisabled hides the one-time-code sign-in routes.
	//
	// Phrased as the negative so the zero value leaves them on: a Config
	// built in a test or by future code that has never heard of this
	// flag gets the behaviour the product was designed around, and only
	// a deployment that deliberately says so loses it. The deployment
	// does say so, because no SMS provider is wired and a door nobody
	// can walk through is worse than no door.
	//
	// Nothing about the OTP code is removed — see httpapi/server.go's
	// route registration.
	OTPSignInDisabled bool
	// The first account, for a deployment where nobody can sign up. Used
	// once, when that phone number has no account yet — see
	// httpapi.BootstrapOwner.
	BootstrapBusiness string
	BootstrapPhone    string
	BootstrapPassword string
	BootstrapOwner    string
	AllowedOrigin     string
	// DefaultTimezone is the IANA zone new businesses get when signup
	// doesn't specify one. Every "today" in this product resolves in the
	// business's own zone (see domain.Business.Today), so this is the
	// single knob that decides when a delivery day rolls over.
	DefaultTimezone string
}

func Load() (Config, error) {
	environment, defaults := defaultsForEnvironment(lower(stringFromEnv("APP_ENV", EnvironmentLocal)))
	// Sessions are long on purpose. Sign-in costs an SMS now, so asking
	// for one every twelve hours would be both expensive and infuriating
	// for someone opening the app each morning. The token is refreshed on
	// use (see httpapi's auth middleware), so this is really an *idle*
	// timeout: it only bites after a genuine absence.
	tokenHours := intFromEnv("TOKEN_TTL_HOURS", defaults.TokenTTLHours)

	cfg := Config{
		Environment:       environment,
		Addr:              stringFromEnv("ADDR", defaults.Addr),
		DatabaseURL:       stringFromEnv("DATABASE_URL", defaults.DatabaseURL),
		JWTSecret:         stringFromEnv("JWT_SECRET", defaults.JWTSecret),
		TokenTTL:          time.Duration(tokenHours) * time.Hour,
		AllowLogOTPSender: boolFromEnv("OTP_ALLOW_LOG_SENDER", false),
		OTPSignInDisabled: boolFromEnv("OTP_SIGNIN_DISABLED", false),
		BootstrapBusiness: stringFromEnv("BOOTSTRAP_BUSINESS", ""),
		BootstrapPhone:    stringFromEnv("BOOTSTRAP_PHONE", ""),
		BootstrapPassword: stringFromEnv("BOOTSTRAP_PASSWORD", ""),
		BootstrapOwner:    stringFromEnv("BOOTSTRAP_OWNER", ""),
		GoogleClientID:    stringFromEnv("GOOGLE_CLIENT_ID", ""),
		AllowedOrigin:     stringFromEnv("ALLOWED_ORIGIN", defaults.AllowedOrigin),
		DefaultTimezone:   stringFromEnv("DEFAULT_TIMEZONE", "Asia/Kolkata"),
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

func boolFromEnv(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return fallback
	}
	return value
}
