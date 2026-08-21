#!/usr/bin/env bash
# Local dev runner: backend on :8087, frontend web on :8104.
#
# Env vars:
#   USE_DOCKER_POSTGRES=0   skip Docker Postgres; backend falls back to
#                           in-memory storage (fine for UI/feature testing,
#                           data does not survive a restart).
#   GOOGLE_CLIENT_ID / EXPO_PUBLIC_GOOGLE_CLIENT_ID
#                           required for admin Google Sign-In. Without it
#                           the sign-in button doesn't render and
#                           /api/v1/auth/google returns 503 — use the
#                           "Continue as local dev admin" button instead.
#                           Drivers never need Google: they sign in with a
#                           phone number and a PIN an admin issued.
set -euo pipefail
cd "$(dirname "$0")"

# .env.local (git-ignored — see .gitignore) is an optional local secrets
# file. Real values never get committed.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

USE_DOCKER_POSTGRES="${USE_DOCKER_POSTGRES:-1}"

if [ "$USE_DOCKER_POSTGRES" = "1" ]; then
  echo "Starting Postgres via Docker Compose..."
  docker compose up -d postgres
  export DATABASE_URL="${DATABASE_URL:-postgres://delivery_manager:dev-local-only@localhost:5437/delivery_manager?sslmode=disable}"
else
  echo "USE_DOCKER_POSTGRES=0 — backend will use in-memory storage."
  unset DATABASE_URL || true
fi

export APP_ENV="${APP_ENV:-local}"
export ADDR="${ADDR:-:8087}"
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
export DEFAULT_TIMEZONE="${DEFAULT_TIMEZONE:-Asia/Kolkata}"

echo "Starting backend on ${ADDR}..."
# -ldflags="-linkmode=external" forces the system (clang) linker instead of
# Go's default internal one. The internal linker doesn't emit an LC_UUID
# load command, and current macOS (Tahoe/26+) refuses to load any binary
# missing one — every locally-built Go binary fails with
# "dyld: missing LC_UUID load command" without this. Requires Xcode Command
# Line Tools (already needed for git/docker, so should be present).
(cd backend && go run -ldflags="-linkmode=external" ./cmd/api) &
BACKEND_PID=$!

cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting frontend on http://localhost:8104 ..."
cd frontend
if [ ! -d node_modules ]; then
  echo "Installing frontend dependencies (first run)..."
  npm install
fi
EXPO_PUBLIC_APP_ENV=local \
EXPO_PUBLIC_API_URL="http://localhost:8087" \
EXPO_PUBLIC_GOOGLE_CLIENT_ID="${EXPO_PUBLIC_GOOGLE_CLIENT_ID:-}" \
  npm run web:8104
