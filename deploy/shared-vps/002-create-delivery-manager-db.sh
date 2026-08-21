#!/usr/bin/env bash
# Copy to 3vnsystems-infrastructure/postgres/init/ alongside
# 001-create-databases.sh.
#
# IMPORTANT: scripts in /docker-entrypoint-initdb.d run ONCE, only when the
# Postgres data volume is first initialized. On a host where Postgres is
# already running with data, this file will never execute — create the role
# and database by hand instead:
#
#   docker compose -f docker/compose.prod.yml exec postgres \
#     psql -U interest_optimizer -c "CREATE USER delivery_manager WITH PASSWORD '...';" \
#     -c "CREATE DATABASE delivery_manager OWNER delivery_manager;"
#
# Per 3vnsystems-infrastructure/PRODUCT-PLANNING.md this product gets its
# own database and role on the shared Postgres instance (the extra
# isolation of a separate instance is reserved for the expense tracker's
# bank data). What is stored here is customer names, phone numbers and
# home locations — genuinely personal, and a good reason to keep the
# nightly pg_dump for this database restricted like any other, but not
# financial-account data.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE USER delivery_manager WITH PASSWORD '${DELIVERY_MANAGER_POSTGRES_PASSWORD}';
    CREATE DATABASE delivery_manager OWNER delivery_manager;
EOSQL
