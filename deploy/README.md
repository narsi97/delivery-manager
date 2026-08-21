# Deploying Delivery Manager

Two supported shapes, one set of images.

|                | Shared 3VNSYSTEMS VPS                    | Dedicated host                          |
| -------------- | ---------------------------------------- | --------------------------------------- |
| URL            | `https://3vnsystems.com/delivery-manager/` | `https://deliveries.example.com/`       |
| Reverse proxy  | the shared Caddy in `3vnsystems-infrastructure` | this repo's `standalone/Caddyfile` |
| Postgres       | shared instance, own database + role     | its own container and volume            |
| Frontend build | `EXPO_WEB_BASE_PATH=/delivery-manager`, `nginx.conf` | base path blank, `nginx.root.conf` |
| Files          | [`shared-vps/`](shared-vps/)             | [`standalone/`](standalone/)            |

Nothing in the application code knows which one it is running under. The
backend reads `DATABASE_URL` and `ALLOWED_ORIGIN` from the environment;
the frontend takes its base path as a build argument. That is the whole
difference — which is what makes moving between them a rebuild rather
than a port.

## Which one?

Start on the shared VPS. It costs nothing extra, it is already backed up
(`3vnsystems-infrastructure/backup/scripts/backup.sh` dumps every database
nightly), and it is one less host to patch.

Move to a dedicated host when one of these becomes true:

- **A customer requires it.** A business that wants its delivery data on
  infrastructure it can point at — or in a particular jurisdiction — is a
  reason on its own.
- **The morning peak starts interfering.** Delivery load is extremely
  spiky: essentially all of a day's route-building and stop-completion
  traffic lands in the same 90 minutes. If that starts showing up in the
  other products' latency, isolate it.
- **The blast radius stops being acceptable.** A driver who cannot close
  stops because an unrelated product wedged the shared host is a real
  operational failure for someone's actual business, not a slow web page.

## Shared VPS

On your machine, push this repo and make sure the VPS can clone it. Then
on the VPS, as a sibling of `3vnsystems-infrastructure`:

```bash
git clone <remote URL> ~/delivery-manager
```

Then, in the `3vnsystems-infrastructure` checkout:

1. Append the services in [`shared-vps/compose.fragment.yml`](shared-vps/compose.fragment.yml)
   to `docker/compose.prod.yml`, and add both to the `caddy` service's
   `depends_on`.
2. Insert the blocks from [`shared-vps/Caddyfile.fragment`](shared-vps/Caddyfile.fragment)
   into `caddy/Caddyfile`, **above** the catch-all `handle` at the end.
3. Append [`shared-vps/root-env.additions`](shared-vps/root-env.additions)
   to `.env` (and to `.env.prod.example`).
4. Copy [`shared-vps/delivery-manager.env.example`](shared-vps/delivery-manager.env.example)
   to `env/delivery-manager.env` and fill it in.
5. Create the database. If Postgres has never been initialized on this
   host, copy [`shared-vps/002-create-delivery-manager-db.sh`](shared-vps/002-create-delivery-manager-db.sh)
   into `postgres/init/` and it runs automatically. **On an existing host
   it will not run** — `/docker-entrypoint-initdb.d` executes only against
   an empty data volume — so create the role and database by hand instead;
   the script's header has the exact command.
6. Add `env/delivery-manager.env` to the guard checks at the top of
   `deploy.sh`, next to the existing two, so a missing file fails loudly
   instead of at container start.
7. `./deploy.sh`

## Dedicated host

```bash
git clone <remote URL> delivery-manager
cd delivery-manager/deploy/standalone
cp .env.example .env
$EDITOR .env          # DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, JWT_SECRET
./deploy.sh
```

Point the domain's A/AAAA record at the host **before** the first run, or
Let's Encrypt cannot validate. Behind Cloudflare, leave the record
DNS-only (grey cloud) until the first certificate is issued.

`deploy.sh` is re-runnable: it pulls, rebuilds, restarts, and then waits
for `/healthz` rather than exiting the moment Compose returns — so a
container that starts and immediately dies is reported as a failure
instead of looking like a successful deploy.

### Backups

The shared VPS already dumps every product database nightly. A dedicated
host does not, and this database is the only copy of a business's customer
list. Set one up on day one:

```bash
docker compose exec -T postgres pg_dump -U delivery_manager delivery_manager | gzip > backup-$(date +%F).sql.gz
```

Put that on a cron and ship the output off the host. A backup that lives
only on the machine it is backing up is not a backup.

## First run, either shape

There are no users until someone signs up, and signup requires Google
Sign-In — so set `GOOGLE_CLIENT_ID` (backend) and the matching
`EXPO_PUBLIC_GOOGLE_CLIENT_ID` (frontend build arg) before going live, or
no admin can get in. The two must be the same OAuth 2.0 Web client ID:
the backend verifies it as the token audience.

Drivers need none of this. An admin creates each driver with a name, a
phone number and a 6-digit PIN, and the driver signs in with those.

## Verifying a deploy

```bash
curl -fsS https://<domain>/delivery-manager/api/v1/healthz   # shared
curl -fsS https://<domain>/healthz                            # dedicated
```

Then sign in as an admin and load the Today tab. A working `/healthz`
proves the container is up; it does not prove the database is reachable,
because the health endpoint deliberately does not touch it — an admin
screen that lists customers does.
