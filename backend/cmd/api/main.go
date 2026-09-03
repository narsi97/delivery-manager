package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"delivery-manager/internal/auth"
	"delivery-manager/internal/config"
	// Registers every built-in extension. Registration does not enable
	// anything — an extension only runs for a business whose config
	// names it. See internal/extensions.
	_ "delivery-manager/internal/extensions/all"
	"delivery-manager/internal/httpapi"
	"delivery-manager/internal/storage"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var store storage.Store
	if cfg.DatabaseURL != "" {
		postgresStore, err := storage.NewPostgresStore(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("connect postgres: %v", err)
		}
		store = postgresStore
		log.Println("using postgres storage")
	} else {
		store = storage.NewMemoryStore()
		log.Printf("using in-memory storage for %s; set DATABASE_URL for postgres", cfg.Environment)
	}
	defer store.Close()

	authService := auth.NewService(cfg.JWTSecret, cfg.TokenTTL)

	// Which door is open is the thing about this process most worth
	// knowing from the logs, so it says so rather than describing the
	// design. The one-time-code path is still compiled in and still
	// tested; OTP_SIGNIN_DISABLED decides whether it is reachable.
	if cfg.OTPSignInDisabled {
		log.Printf("sign-in: phone + password (one-time codes are switched off — no SMS provider); "+
			"sessions last %s and refresh on use", cfg.TokenTTL)
	} else {
		log.Printf("sign-in: phone + password, or a one-time code; sessions last %s and refresh on use", cfg.TokenTTL)
	}
	log.Printf("new businesses default to timezone %s", cfg.DefaultTimezone)

	api := httpapi.NewServer(store, authService, cfg)
	// The first account, when nobody can sign up. A no-op unless it is
	// configured and that number has no account yet.
	if err := api.BootstrapOwner(ctx, cfg.BootstrapBusiness, cfg.BootstrapPhone,
		cfg.BootstrapPassword, cfg.BootstrapOwner); err != nil {
		log.Fatalf("bootstrap owner: %v", err)
	}
	httpapi.SetAllowedOrigin(cfg.AllowedOrigin)
	log.Printf("CORS allowed origin: %s", cfg.AllowedOrigin)

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("delivery-manager API listening on %s", cfg.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
}
