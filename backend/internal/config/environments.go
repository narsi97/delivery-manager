package config

type EnvironmentDefaults struct {
	Addr          string
	DatabaseURL   string
	JWTSecret     string
	TokenTTLHours int
	// AllowedOrigin is the default Access-Control-Allow-Origin value for
	// this environment. "*" in local/dev keeps cross-port local testing
	// frictionless; prod defaults to the one real deployed origin so a
	// stolen/leaked bearer token can't be replayed from an arbitrary site.
	AllowedOrigin string
}

const (
	EnvironmentLocal = "local"
	EnvironmentDev   = "dev"
	EnvironmentProd  = "prod"
)

// Ports intentionally differ from the other 3VNSYSTEMS products
// (Interest Optimizer 8081/8099, Resume Optimizer 8083/8100, Expense
// Tracker 8085/8102) so every product's local dev servers can run side by
// side on one machine.
var environmentDefaults = map[string]EnvironmentDefaults{
	EnvironmentLocal: {
		Addr:          ":8087",
		DatabaseURL:   "",
		JWTSecret:     "dev-secret-change-me",
		TokenTTLHours: 24 * 30,
		AllowedOrigin: "*",
	},
	EnvironmentDev: {
		Addr:          ":8080",
		DatabaseURL:   "",
		JWTSecret:     "dev-secret-change-me",
		TokenTTLHours: 24 * 30,
		AllowedOrigin: "*",
	},
	EnvironmentProd: {
		Addr:        ":8080",
		DatabaseURL: "",
		JWTSecret:   "",
		// Drivers stay signed in for a fortnight: re-entering a PIN at
		// 5am in the cold, on a phone with gloves on, is exactly the
		// friction that gets an app abandoned. The token carries only a
		// driver's own route, so the blast radius of a stolen handset is
		// one round's customer list — and an admin can deactivate the
		// driver, which invalidates them at the next request.
		TokenTTLHours: 24 * 30,
		AllowedOrigin: "https://3vnsystems.com",
	},
}

func defaultsForEnvironment(environment string) (string, EnvironmentDefaults) {
	defaults, ok := environmentDefaults[environment]
	if !ok {
		return EnvironmentLocal, environmentDefaults[EnvironmentLocal]
	}
	return environment, defaults
}
