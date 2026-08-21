#!/usr/bin/env bash
# Run on the dedicated host, from a checkout of this repo. Pulls the latest
# source, rebuilds the two images locally, and restarts what changed.
#
# Images are built from source on the host rather than pulled from a
# registry — the same choice the shared 3VNSYSTEMS stack makes, and for the
# same reason: no Docker Hub account or CI image-push step is needed to get
# a deploy running.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/../.." && pwd)"
cd "${DEPLOY_DIR}"

if [[ ! -f .env ]]; then
  echo ".env not found. Copy .env.example to .env and fill in real values first." >&2
  exit 1
fi

if [[ -d "${REPO_ROOT}/.git" ]]; then
  if git -C "${REPO_ROOT}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "Pulling latest source..."
    git -C "${REPO_ROOT}" pull --ff-only
  else
    echo "No upstream remote configured — deploying the working tree as-is." >&2
  fi
fi

echo "Building and restarting..."
docker compose up -d --build

echo "Waiting for the backend to report healthy..."
for _ in $(seq 1 30); do
  if docker compose exec -T backend wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "Backend is healthy."
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "Backend did not become healthy in time. Recent logs:" >&2
docker compose logs --tail 50 backend >&2
exit 1
