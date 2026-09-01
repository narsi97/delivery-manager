# Compromises, and what it would take to undo them

Every entry here is a place where the simple version shipped and the
thorough version didn't. None of them are bugs and none are accidents —
each was chosen, usually to get something in front of a real user
sooner. They are written down because the reason for a shortcut is the
first thing forgotten, and the second thing is that it was a shortcut at
all.

Each entry says what we do instead, what it costs, and what undoing it
actually involves. Delete an entry when it stops being true.

---

## Auth and security

### Codes are written to the log, not sent as SMS

**Now:** `internal/notify` is a one-method `Sender`; the shipped
`LogSender` writes the one-time code to the server log.

**Costs:** in production this means *anyone who can read the container
logs can sign in as any user*. The obfuscated URL is doing real work as
access control, which is not what obscurity is for.

**To undo:** add an `MSG91Sender` (India-appropriate, cheap) or
`TwilioSender` implementing the same interface, put its credentials in
`env/delivery-manager.env`, and remove `OTP_ALLOW_LOG_SENDER`. MSG91
additionally needs a DLT-registered template before Indian carriers will
deliver anything — that is a paperwork lead time, not a code change, so
start it before you need it.

### Production runs `APP_ENV=dev`, so `dev-login` is live

**Now:** `POST /api/v1/auth/dev-login` is registered in production and
mints an admin session with no credentials at all.

**Costs:** the deployment is one URL away from being fully open. This is
survivable while the only data is seeded test data. **It stops being
survivable the moment real customer records are loaded** — those are
personal data under the DPDP Act.

**To undo:** set `APP_ENV=prod` in `env/delivery-manager.env` *and* the
`EXPO_PUBLIC_APP_ENV` build arg together (they gate the same thing on
each side), which requires the SMS sender above to exist first — with
neither, nobody can sign in at all.

### Anyone with a phone number can create a business

**Now:** signup needs a working phone and nothing else.

**Costs:** no defence against junk tenants. Cheap today: an empty tenant
created by a stranger reaches no one and costs a database row.

**To undo:** a review queue and a `verified` flag on the business, plus
somebody whose job is to look at it. Worth doing when signups are real,
not before.

---

## Routing and priority

### Priority is three tiers, not delivery deadlines

**Now:** `domain.PriorityTier` — business / early / normal. Higher tiers
are visited before lower ones; the best path is computed within each
tier.

**Costs:** "before 07:30" cannot be expressed or promised. A tier says
*sooner*, not *by when*, so a long enough route can still arrive late at
a customer who needs milk before school and nothing will warn anyone.

**To undo:** per-customer time windows and a solver that respects them
(vehicle routing with time windows). The genuinely hard part is not the
solver but the honesty: time windows can be **infeasible**, so the app
would have to detect and say "these three cannot all be met" rather than
silently producing an order that misses one.

### A driver's limit is one number, applied per round

**Now:** `domain.User.MaxStops` — how many deliveries fit in this
driver's van. It is stored on the driver rather than on a route, so it
survives the day rebuilding itself, and it is applied to *each* round
that driver is on.

**Costs:** a driver given two service areas on the same day can be
handed `MaxStops` on each, so a limit of 20 becomes 40. Nobody has hit
this because a driver drives one round a morning, but nothing stops it.
There is also no per-day or per-area override: "Ravi can only do ten
*today*" has to be typed and untyped.

**To undo:** cap against the driver's whole day rather than each round —
sum what their other rounds already hold before filling the next one. The
place to do it is the `capOfRound` map in `ensureDayRounds`, which would
become a per-driver budget drawn down across their rounds.

### Work beyond every cap is left unassigned, not moved

**Now:** stops past the limit come off the round and show under "not
going out". Priority customers are kept first, so a shop is never the one
dropped (`PartitionCapped` sorts by band before distance).

**Costs:** the admin has to notice and act. Nothing offers the overflow
to a driver in a neighbouring area, or suggests raising a limit.

**To undo:** the honest version is a suggestion, not an automatic
reassignment — "3 deliveries won't fit; Kumar has room" — because moving
someone's stops onto a driver who never agreed to them is exactly the
overload this was built to prevent.

### Reordering is up/down buttons, not drag

**Now:** each stop moves one place at a time, with a "move to position"
for longer jumps.

**Costs:** shuffling a stop from 40th to 2nd is tedious.

**To undo:** a gesture library (`react-native-draggable-flatlist`) or a
hand-rolled `PanResponder`. The real work is stopping a drag inside a
scrolling list from hijacking the scroll on a phone, which is why this
was not the first version. The underlying model already supports it —
dragging would write the same pinned sequence the buttons do.

---

## Driver check-in

### The driver reports a count; there is no photo

**Now:** at the farm the driver enters the number of units taken, the
admin approves, and the stop list unlocks.

**Costs:** the count is unevidenced. It is the driver's word, which is
exactly what the photo was meant to replace.

**To undo:** object storage, which this stack does not have — see
`Docs/ARCHITECTURE.md`, which flags it as deliberately absent. Either
self-host MinIO next to Postgres (a container, a volume, backup config,
credentials — and reusable by the other 3VNSYSTEMS products) or use an
S3-compatible bucket. Then presigned upload from the phone, and a
thumbnail on the approval screen. Do **not** solve it by putting image
bytes in Postgres: a phone photo is 2–5 MB and two drivers on a daily
round is roughly 3 GB a year on a 38 GB disk, inside the same dump the
nightly backup copies.

---

### The check-in gate is not optional per business

**Now:** every driver on every business must have their load counted and
approved before their stops appear.

**Costs:** a one-person dairy where the owner is also the driver has to
approve their own count each morning, which is ceremony rather than
control.

**To undo:** a flag on `BusinessConfig` (which already exists for exactly
this kind of per-tenant switch) and a check in `handleDriverToday`. Not
done now because the business that asked for it wants it on, and a
setting nobody has asked to turn off is a setting nobody maintains.

## Vocabulary and naming

### The Go internals still say "round"

**Now:** `ensureDayRounds`, `handlePlanRounds`, `prepareSplitArea`'s
neighbours and assorted comments use "round" where every user-facing
string and the whole frontend say "route".

**Costs:** nothing functional; a reader has to hold two words for one
concept.

**To undo:** a rename pass over the backend. Deliberately *not* bundled
with feature work: renaming exported handlers mid-change is precisely
how `api.planRoutes` came to be broken in production — the call site was
updated and the export was not.

---

## Operations

### Production session length disagrees with the code

**Now:** `environments.go` defaults to 30 days; the VPS's
`env/delivery-manager.env` sets `TOKEN_TTL_HOURS=336` (14 days), which
wins.

**Costs:** small — 14 days is still a long idle timeout — but the code
and the running system say different things, which is how surprises
start.

**To undo:** pick one. Either drop the env override or change the
default to match it.

### The VPS cannot pull the infrastructure repo

**Now:** `3vn-infra` is private and the box has no GitHub credentials,
so its checkout is a local-only git repo kept in step by hand.

**Costs:** config drift between the repo and what is actually running —
which is exactly the state that hid delivery-manager's entire deployment
from the repo for weeks.

**To undo:** a deploy key on the VPS, then `deploy.sh` pulls infra like
it pulls the product repos.
