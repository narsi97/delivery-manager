# Architecture: one codebase, many businesses

V1 serves one business. The design assumes it will not stay that way, and
the point of this document is to record *where* variation is allowed to
live so that the second, fifth and twentieth business don't each leave a
scar in the core.

## The invariant core

```
Business
  └── Customers            (a person at a pinned location)
        └── RecurringOrder (the standing arrangement: 2L, Mon-Fri)
              └── DailyOrder  (one concrete task on one date)
                    └── Route     (an ordered set of DailyOrders)
                          └── Stop  (a DailyOrder as the driver sees it)
                                └── DeliveryEvent (what happened, who did it)
```

Every vertical reduces to this. A milk round is quantities of a product at
a door. A school run is a student at a pickup point with a seat on a bus.
A water delivery is a can out and an empty can back. The nouns differ; the
shape does not.

Two decisions inside the core carry most of its weight:

**Daily tasks are generated from subscriptions, never edited into them.**
A subscription says what usually happens; a `DailyOrder` is one date's
instance of it. "No milk this week" is a change to four `DailyOrder` rows,
not to the subscription — so the standing arrangement survives, and the
customer's normal service resumes without anyone having to remember to put
it back. Generation is idempotent (`Store.EnsureDailyOrder`) precisely
because an admin will press *Generate* again at 6:40am after adding a
customer, and that must not wipe the overrides and completed deliveries
already recorded for the day.

**The pin is the address.** Routing uses `lat`/`lng`; the text address is
for humans. Rural and semi-urban addresses geocode badly or not at all, so
an admin drops a pin — often by standing at the door and capturing GPS.

## Four layers of variation

| Layer | What varies | Where it lives | Status |
| --- | --- | --- | --- |
| 0 | The model above | Go types | fixed |
| 1 | Vocabulary | `businesses.config → terminology` | built |
| 2 | Extra data per customer / delivery | declared `FieldSpec`s + `custom_fields` JSONB | built |
| 3 | What a driver must capture at the door | declared `CaptureSpec`s, validated server-side | built |
| 4 | Genuinely bespoke logic | `internal/extensions`, opt-in per business | seam built, one extension |

### The rule that holds it together

**`BusinessType` is seed data, not behaviour.**

`domain.PresetFor` is the *only* function that switches on a business
type, and all it does is produce a starting configuration and a starter
product list, which are **copied** into the tenant at signup. From that
moment the business owns its config and can diverge from its vertical
freely. Nothing downstream ever asks "is this a school?" — it asks the
config what to call things, what fields exist, and what the driver must
record.

This is worth defending in review, because the alternative is seductive
and cheap the first time. `switch businessType` inside the scheduler works
fine for two verticals and is unmaintainable at five: every new vertical
means auditing every branch, and a business that wants one small deviation
from its vertical's assumptions has nowhere to put it. Here, "a school
that also collects cash" is a config edit.

`TestEveryPresetIsValidAndComplete` enforces the other half of this: every
shipped preset must be a config a business could have saved through the
normal config editor. A preset that the validator would reject is a preset
that writes data the product can't subsequently edit.

### Layer 1 — terminology

Labels only. Renaming a customer to a student changes not one line of
routing, scheduling or persistence. It exists because being made to read
"customer" all day is exactly the friction that makes a generic product
feel like it wasn't built for you.

### Layer 2 — custom fields

A business declares fields (`key`, `label`, `type`, `required`,
`applies_to`), and the matching records carry values in a `custom_fields`
JSONB column. Adding "guardian phone" is a config edit, not a migration.

Two deliberate constraints:

- **Undeclared keys are rejected, not stored.** A JSONB bag that accepts
  anything becomes a landfill within a year: typo'd keys, values from a
  half-finished feature, data nobody can safely delete because nobody
  knows what writes it. Rejecting at the boundary keeps what's on disk
  equal to what's declared.
- **Removing a declaration does not delete recorded values.** A business
  must be able to stop collecting something, but an invoice or a dispute
  may depend on what was already recorded. The values stop being displayed
  and stop being accepted on new writes; they stay on the rows that have
  them.

The type set (`text`, `number`, `boolean`, `phone`) is small on purpose.
Each round-trips through JSON, renders as an obvious input, and validates
in a couple of lines. Dates, enumerations and file uploads are additions
to make when a business needs one — file uploads in particular need
object storage, which this product does not have yet.

### Layer 3 — stop captures

The doorstep equivalent: what the driver must supply to close a stop,
gated by outcome. A school's "handed to" is required on a completed drop
and meaningless on a failure; a water business records empty cans
returned.

Captures are validated **before** anything is written, so a stop is never
left half-closed with a required value missing. The one asymmetry: a
capture submitted for the wrong outcome is *dropped* rather than refused —
an app that hasn't refreshed its config must never be able to block a
driver from reporting what actually happened.

### Layer 4 — extensions

For the remainder: a rule that genuinely needs to *run*. The worked
example is `every_n_days` — alternate-day milk delivery, which a weekday
mask cannot express at all, because "every other day" doesn't align to a
week and drifts across weekdays forever.

It also demonstrates the layers composing: the interval is a **custom
field on the customer** (layer 2), so enabling the rule needs no schema
change and no new API — the existing custom-field form already edits it.

Three properties are deliberate:

- **Opt-in per business.** An extension runs only for tenants whose config
  names it. A business that never asked for a bespoke rule is unaffected
  by every bespoke rule that exists — which is what makes it safe to keep
  adding them. `TestExtensionsAreScopedToTheBusinessThatEnabledThem` and
  `TestNoIntervalMeansDeliverNormally` guard this; an extension leaking
  onto a customer who never opted in would silently cancel real
  deliveries, which is the worst failure this design can have.
- **Compiled in, not loaded.** Ordinary Go packages, built into the binary
  and covered by the normal test suite. A plugin runtime would buy dynamic
  loading nobody needs and cost type-checking and testability.
- **Quarantined.** Bespoke logic lives in `internal/extensions/<name>/`
  and is called from exactly one place in the core. When a customer
  leaves, deleting their extension is deleting a directory.

There is **one hook point** (order generation) because there is one real
use for one. Adding the next — post-delivery notifications, invoicing — is
the same shape: a narrow interface in `internal/extensions`, resolved at
the one boundary in the core where the decision is actually made. Resist
adding hooks before something needs them; an unused hook is an untested
hook.

An extension that errors **stops the generation run**. Half a milk round
is worse than a visible failure an admin can retry. An extension that is
*named but missing from the build* is logged and ignored — that is a
deployment mismatch, and degrading to core behaviour is better than
refusing to produce a day's work.

## What is deliberately not built

Named here so nobody has to re-derive whether they were forgotten.

- **Road-distance routing.** Stop ordering uses straight-line distance
  with nearest-neighbour + 2-opt, and navigation is delegated to the
  driver's own map app. For 30–80 stops in dense residential streets this
  usually produces the order a human would pick, at zero per-request cost
  and with no external dependency on the critical morning path.
  `route.Optimize`'s signature is deliberately boring so that swapping in
  a real distance matrix (OSRM, ORS, Google) later changes how the cost
  between two points is obtained and nothing that calls it.
- **Proof of delivery (photos, signatures).** Needs object storage. See
  `3vnsystems-infrastructure/PRODUCT-PLANNING.md`, which already has an
  opinion about self-hosted MinIO versus an S3-compatible bucket.
- **The customer app.** `Customer.AccountID` is nullable from day one
  precisely so that a customer can later *claim* an existing record rather
  than needing a parallel table to migrate into. Customer-side pause and
  quantity changes will use the same override mechanism the admin uses.
- **Billing.** `Product.PriceCents` and `DailyOrder.Quantity` are recorded
  for every delivery, so the data an invoice needs is already accumulating.
- **Multiple runs per day.** A school's morning pickup and afternoon drop
  are currently two products on one date. If that proves awkward, the
  change is a run/shift identifier on `DailyOrder` and `Route` — not a new
  model.
- **Shared SSO across 3VNSYSTEMS products.** Per `PRODUCT-PLANNING.md`,
  revisit at 3+ live products.

## The one deliberate deviation from house standards

`PRODUCT-PLANNING.md` standardises every 3VNSYSTEMS product on
Google-only sign-in, no passwords. Admins here follow that exactly.

**Drivers do not.** They sign in with a phone number and a 6-digit PIN
issued by their admin. A driver is a *staff member of a tenant*, not a
self-service signup: their account is created by their employer, they may
share a handset, and requiring each of them to have and use a Google
account is the kind of friction that stops a small dairy adopting the
product at all.

What makes a six-digit secret acceptable is the surrounding controls, not
its entropy:

- bcrypt at rest, and the hash is deliberately not a field on
  `domain.User`, so it cannot be serialized into an API response by
  accident;
- rate limiting per phone number (10/hour) — with a search space only a
  million wide, this is what actually provides the security;
- guessable PINs (all-same-digit, runs like `123456`) rejected at the one
  place credentials are written;
- identical error text for "unknown number" and "wrong PIN", so the
  endpoint can't enumerate which numbers are registered drivers;
- sessions validated against the live user record on **every** request, so
  deactivating a driver logs them out at their next action rather than
  whenever their token happens to expire. That is the real answer to a
  lost handset, and it's why the token TTL can safely be a fortnight.

Phone numbers normalize to their last ten digits, so an admin who saves
`+91 98765 43210` and a driver who types `9876543210` resolve to the same
account. The trade-off — two numbers in different countries sharing their
last ten digits collide — fails loudly at driver creation (a 409) rather
than silently admitting the wrong person, and the fix when it matters is a
per-business dial code plus a backfill.
