# Delivery Manager

Recurring deliveries, optimized rounds, one app. A dairy delivering milk
every morning, a school running a bus, a water supplier swapping cans —
all of them are the same problem: a set of customers at pinned locations
who expect something on a repeating schedule, a driver who has to visit
them in a sensible order, and an office that needs to know what actually
happened.

Product #4 in the 3VNSYSTEMS lineup.

```
Business → Customers → Recurring orders → Daily deliveries → Routes → Drivers
```

## What it does today

**Admin console**

- Sign up a business, pick a vertical, get a working starting configuration
- Add customers with a map pin — typed coordinates, or captured from the
  device while standing at the door
- Set standing orders ("2L of milk, Mon–Fri")
- Generate the day's deliveries from those standing orders, repeatedly and
  safely
- Override a single date — extra today, none this week — without touching
  the customer's standing arrangement
- Build an optimized round from a start point and hand it to a driver
- Watch the day: pending, delivered, failed, skipped

**Driver app**

- Sign in with a phone number and a PIN their admin issued — no Google
  account, no email
- One screen: the next stop, then the rest in driving order
- Navigate hands off to whichever map app is already on the phone
- Mark delivered or couldn't-deliver, with a note, and whatever else the
  business requires at the door

**Not built yet:** the customer-facing app, billing, proof-of-delivery
photos, road-distance routing. See [`Docs/ARCHITECTURE.md`](Docs/ARCHITECTURE.md)
for what each of those needs and why it waited.

## Run it locally

```bash
./run-local.sh
```

Backend on `:8087`, frontend on `:8104`, Postgres on `:5437` via Docker.
No Docker? `USE_DOCKER_POSTGRES=0 ./run-local.sh` runs against in-memory
storage — fine for exercising the whole flow, gone on restart.

Google Sign-In needs credentials, so local dev has a **"Continue as local
dev admin"** button that creates a demo business and signs you in. It only
exists when `APP_ENV != prod`; the route isn't even registered in
production.

To try a vertical other than dairy locally:

```bash
curl -s localhost:8087/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"business_type":"school"}'
```

...and the demo business comes up calling customers *students*, requiring
a guardian's phone number, and asking the driver who they handed the
student to.

### A five-minute demo round

1. Sign in with the dev admin button
2. **Customers** → add two or three, using "Pin my current location" (or
   type coordinates near each other), and give each a standing order
3. **Today** → *Generate today's deliveries*
4. **Drivers** → add a driver with a phone number and a 6-digit PIN
5. **Today** → set the start point, *Build optimized route*, assign the driver
6. Sign out, switch to the **Driver** tab, sign in with that phone and PIN
7. Work the round

## Tests

```bash
cd backend && go test ./...
```

The suite is behavioural rather than unit-shaped: `internal/httpapi` drives
the real server over HTTP against the in-memory store, so routing,
middleware, role checks and JSON shapes are covered by the same pass.
`TestFullDeliveryDay` walks the entire product end to end — admin sets up
a dairy, overrides a customer, builds and assigns a route, driver signs in
with a PIN and completes the round.

## Layout

```
backend/
  cmd/api/              composition root
  internal/domain/      the model, the config layer, the vertical presets
  internal/route/       stop ordering (haversine + nearest-neighbour + 2-opt)
  internal/storage/     Store interface, Postgres and in-memory implementations
  internal/httpapi/     handlers, auth middleware, tenant scoping
  internal/auth/        JWT, Google ID tokens (admins), PINs (drivers)
  internal/extensions/  per-business bespoke logic, opt-in
  migrations/           readable SQL mirror of internal/storage/schema.go
frontend/               Expo / React Native Web — admin console and driver app
deploy/                 shared-VPS fragments and a self-contained stack
Docs/ARCHITECTURE.md    why the model is shaped this way, and where to extend it
```

## Two things worth knowing before changing anything

**Business type is seed data, not behaviour.** `domain.PresetFor` is the
only function that switches on a vertical, and it only produces defaults
that get copied into the tenant at signup. Everything downstream reads the
business's *config* — what to call things, what fields exist, what the
driver must capture. Please don't add `if businessType == ...` anywhere
else; [`Docs/ARCHITECTURE.md`](Docs/ARCHITECTURE.md) explains what that
buys.

**Regenerating a day must never destroy what's already there.** Admins
press *Generate* repeatedly through a morning. `Store.EnsureDailyOrder`
creates or returns-untouched, and that "untouched" is load-bearing: it is
what protects overrides an admin made and deliveries a driver already
completed.

## Deploying

Two shapes, one set of images: a pair of services inside the shared
3VNSYSTEMS stack at `3vnsystems.com/delivery-manager/`, or a self-contained
stack with its own Caddy, Postgres and domain on a dedicated host.
See [`deploy/README.md`](deploy/README.md), including when it's worth
moving from the first to the second.
