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

	// Sign-in is a phone number and a code, for owners and drivers alike
	// — there is nothing to configure for it to work, but there *is*
	// something to configure before codes actually reach a handset. Say
	// which of those two states this process is in, loudly, because the
	// difference is "anyone with log access can sign in as anyone".
	log.Printf("sign-in: phone + one-time code; sessions last %s and refresh on use", cfg.TokenTTL)
	log.Printf("new businesses default to timezone %s", cfg.DefaultTimezone)

	api := httpapi.NewServer(store, authService, cfg)
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
