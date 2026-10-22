# BharatCode Teams

Campus and Team plans for BharatCode. Colleges and companies buy seats in bulk, pay by UPI Autopay
or payment link, receive GST invoices, and see per-seat usage. The model gateway asks this service
whether a user is covered by an organisation.

It is a standalone service so it can ship without changes to the private gateway beyond two HTTP
calls (see [docs/INTEGRATION.md](docs/INTEGRATION.md)).

## Why this exists

Individual Lite/Pro plans cap out at what students and indie developers will pay each month. The
same product sold per seat to placement cells, coding clubs and small engineering teams brings
larger, annual, lower-churn contracts:

| Plan | Price per seat (excl. GST) | Minimum | Collection |
|---|---|---|---|
| Team Pro, monthly | ₹999 / month | 2 seats | UPI Autopay up to 12 seats, then payment link |
| Team Pro, annual | ₹9,990 / year (2 months free) | 2 seats | Payment link (invoice-style) |
| Campus Lite, annual | ₹1,999 / year | 50 seats | Payment link (invoice-style) |
| Campus Pro, annual | ₹5,999 / year | 10 seats | Payment link (invoice-style) |

Autopay needs every debit to stay within the RBI e-mandate limit of ₹15,000, so only Team Pro
monthly (up to 12 seats) can use it; every annual plan's minimum charge is above the limit.

Prices are quoted excluding GST because GST-registered buyers claim the 18% back as input tax
credit, so a team seat costs the same as individual Pro. They are set in
[src/catalog.ts](src/catalog.ts) and are a business decision, not a technical one.

## What it does

- **Organisations and seats.** Owner, admin and member roles. Seat limits are enforced in a
  transaction with the org row locked, and a user holds at most one active seat (unique index).
- **Invites.** Single-use email invites or multi-use links with a WhatsApp share URL. Tokens are
  256-bit random values stored only as SHA-256 hashes.
- **Campus auto-join.** Admins verify a domain with a DNS TXT record. Students whose confirmed
  email matches (optionally including subdomains such as `cse.college.ac.in`) can discover and
  join. Campus plans require an academic domain (`.ac.in`, `.edu.in`, `.res.in`, `.edu`).
- **Abuse controls.**
  - Email confirmation is checked through the Supabase Admin API (`email_confirmed_at`), never
    the user-editable `user_metadata`.
  - Every campus member, including those joining by invite, needs a confirmed email on one of the
    campus's verified domains, so a company cannot buy student-priced seats for its staff. A paid
    campus cannot remove its last academic domain.
  - A freed seat stays unavailable to newcomers for `SEAT_COOLDOWN_DAYS` (default 7), so one seat
    cannot be rotated through a class.
  - Each org can start at most 10 payment requests an hour, since each one emails the buyer.
- **Razorpay billing.**
  - Charges up to ₹15,000 (the RBI e-mandate limit) use subscriptions, i.e. UPI Autopay or card
    mandates. Larger charges use payment links that Razorpay emails to the billing contact.
  - A daily renewal job sends payment-link renewals before the period ends.
  - Extra seats are sold mid-period as a prorated top-up.
  - A mandate's amount is fixed, so changing the renewal quantity creates a replacement
    subscription that starts at the period end. The current mandate is cancelled only after the
    replacement is authorised, so an admin who ignores the new link keeps renewing at the old
    count instead of losing the plan.
  - Any newer request withdraws unpaid older ones (links cancelled, mandates stopped). A payment
    that still arrives on a withdrawn checkout is not applied: it raises a billing alert for a
    refund, and a stray mandate is stopped so it cannot charge again.
  - Turning auto-renew off stops the mandate after the cycle already paid for.
  - Every Razorpay cancellation goes through a transactional outbox: recorded in the same
    database transaction as the decision, executed right after commit, and retried by a job, so a
    crash or provider outage cannot leave a mandate charging.
- **Webhooks.** Verified with HMAC-SHA256 over the raw body and de-duplicated by event id and by
  body hash (the id header is not signed). All database effects commit in the same transaction as
  the dedupe row, and rows are always locked org-first, the same order as the API, so the two
  cannot deadlock. A retried delivery of an older cycle never moves a period backwards. The charged amount is reconciled
  against our quote; a mismatch raises a `billing_alerts` row instead of issuing a wrong invoice.
- **GST invoices.**
  - GSTIN validated with the official mod-36 checksum. Place of supply comes from the buyer's
    GSTIN (B2B) or billing state.
  - Tax is CGST + SGST for intra-state buyers and IGST otherwise, in exact integer paise.
  - Invoice numbers are `BC/2627/000001`: unique and gapless per Indian financial year
    (April–March, IST) and at most 16 characters, per GST Rule 46.
  - Invoices are immutable snapshots, with a printable HTML view.
- **Usage.** The gateway posts usage batches (idempotent by batch id). Days are bucketed in IST.
  Admins get per-member and daily reports.
- **Entitlements.** One call tells the gateway whether a user is covered, at which tier, and
  whether Zero Data Retention applies. Past-due orgs get a 7-day grace period. Over-limit orgs
  keep owners, then admins, then the earliest joiners.

## Running it

```bash
npm ci
cp .env.example .env   # fill in values
npm run build && npm start   # applies migrations on start (MIGRATE_ON_START=true)
```

`npm run check` runs typecheck, lint (typescript-eslint strict, type-checked) and the tests. Tests
run against real Postgres via [PGlite](https://pglite.dev), so they need no database server.

`npm run build && npm run smoke` boots the built server and drives a full customer journey over
real HTTP (33 checks): checkout, signed webhooks, GST invoice, invites, seat limits, entitlements,
usage, seat changes, mandate hand-over, campus domain checks and the background jobs. It uses a
Postgres wire-protocol server (PGlite) and local stand-ins for Razorpay and Supabase.

Deploy the Dockerfile anywhere that runs containers (Cloud Run fits the existing GCP setup), with
Postgres 14+ (Supabase Postgres works). Schedule `POST /internal/v1/jobs/provider-actions` every
10 minutes and `POST /internal/v1/jobs/renewals` daily.

## API

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the gateway contract, Razorpay setup and the
full route list.

## Before going live

These need a person, not code:

- Have the company's CA confirm the SAC code (default 997331) and the invoice format.
  E-invoicing (IRN) becomes mandatory once turnover passes ₹5 crore. Rule 46 asks for a signature
  or digital signature on invoices; add DSC signing or IRN generation when either applies.
- Create the four Razorpay subscription plans with the GST-inclusive amounts listed in the
  integration doc. Startup verifies them and disables autopay for any that do not match.
- Refunds under the 30-day guarantee need a GST credit note. This version raises alerts for cases
  that need a refund but does not issue credit notes yet.
- Verified domains are not re-checked after verification. Add periodic re-verification and a
  dispute process before campuses rely on it at scale.
- Turn on "Confirm email" in Supabase Auth, and create a service-role key used only by this
  service.
