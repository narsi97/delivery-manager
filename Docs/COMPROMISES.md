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

### Sign-in is a password, and the one-time code is switched off

**Now:** phone number + password (`auth/password.go`, `httpapi/
passwordauth.go`). The OTP path is untouched — it compiles, its tests
run, and `OTP_SIGNIN_DISABLED=0` puts its routes back — but no SMS
provider is wired, so a code can only reach the server log.

**Costs:** a password is something to forget, and there is no channel to
send a reset down, so the reset path is a human: the owner sets each
driver's, and whoever runs the deployment sets the owner's. Passwords
therefore travel by word of mouth and are often never changed. There is
also no self-serve signup and no phone verification — accounts are
created *for* people (`BootstrapOwner`, and the owner adding drivers).

**To undo:** configure a provider in `internal/notify`, drop
`OTP_SIGNIN_DISABLED`, and the designed door opens again. The password
door can stay alongside it or go; nothing else depends on it.

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

### The hand order is per-customer, not per-day

**Now:** `domain.Customer.Rank` — drag the roster into the order you
drive it, and it sticks. A ranked customer gets a band of their own
inside their tier (`RouteBand`), so the order is honoured; unranked
customers share the last band and are still routed by shortest path.

**Costs:** it is one order, not one per day or per shift. A business
that runs a different sequence on Saturdays has to either accept the
weekday order or re-drag. Ranking is also global to the customer rather
than to a route, so the same customer cannot sit third on one round and
tenth on another.

**To undo:** rank would have to move off the customer and onto whatever
the "list served together" ends up being — see the note below on shifts,
which is the same question arriving from the other direction.

### Today's route reorders by button; only the roster drags

**Now:** the customer roster drags (HTML5 drag events on a raw `<div>`,
with arrows beside it for touch and keyboard). A stop on *today's* route
still moves one place at a time with the arrows in `StopCard`.

**Costs:** shuffling today's 40th stop to 2nd is tedious. The roster's
drag is also mouse-only — on a phone it falls back to the arrows, which
is the honest behaviour but not the same experience.

**To undo:** the same drag treatment on `StopCard`, and a pointer-event
implementation to replace HTML5 drag events for touch. The real work is
stopping a drag inside a scrolling list from hijacking the scroll on a
phone, which is why the arrows exist on both and are not going away.

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

### The UI says "service route"; the code says "service area"

**Now:** the standing list that produces one route a day is called a
**service route** everywhere a user can see, and `ServiceArea`
everywhere in Go, the database, and the API path
(`/api/v1/service-areas`). `Customer.ServiceAreaID` is the hand
assignment behind it.

**Costs:** the same second name to learn as "round" below, and this one
is worse — "area" now actively misdescribes the thing, because a service
route no longer has to be geographic. Two of them can cover exactly the
same streets, and a customer can be on one whose circle is nowhere near
their pin.

**To undo:** rename the type, the table, the column and the endpoint
together. The endpoint rename is the only part that is not mechanical —
it needs the old path kept alive until every client has moved.

### Undo lives on one screen and forgets itself

**Now:** `undo.js` — every save on the customer roster records how to
reverse itself, and an Undo/Redo bar sits above the list. The stack is
in React state: twenty entries, gone on reload or when you leave the
tab.

**Costs:** nothing on Today, Drivers or Business can be undone, and
"undo" means "PATCH the old values back" rather than a real revert. If
somebody else edited that customer in between, undo silently overwrites
their change too — last write wins, with no warning.

**To undo:** row versions on the customer, so an undo can refuse when
the row moved underneath it. That is the piece the backend does not have,
and inventing it for undo alone would be the tail wagging the dog — the
same versioning is what a real multi-user story needs anyway.

### A new route never takes settled customers, even when it should

**Now:** creating a service route pins anybody it would have taken off
an existing route back to the route they were already on, and reports
them so the screen can offer to hand them over
(`keepCustomersWhereTheyAre`).

**Costs:** the safe default is the wrong one when the new route is a
*better* description of where those customers belong — drawing a
tight "Kodad" circle inside a sloppy 25 km "Nalgonda" one leaves the
Kodad customers on Nalgonda until somebody presses the button. And it
is a one-time offer: dismiss it and the only way back is the picker on
each customer's card.

**To undo:** make the offer durable rather than a notice — a "3
customers could be on this route" line on the route's own row, computed
live, so it is answerable later and not just at creation.

### A service route is still drawn as a circle

**Now:** every service route has a centre and a radius, and claims
customers by pin unless they were placed by hand.

**Costs:** a route that is purely a list — "these twenty shops, wherever
they are" — still has to be given a circle somewhere, and that circle
will silently claim any new customer pinned inside it.

**To undo:** allow `radius_meters` of zero to mean "members only, no
geography", and teach `areaContaining` to skip those. The resolution
order in `areaForCustomer` already supports it — a members-only route
would simply never win the geographic fallback.

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
