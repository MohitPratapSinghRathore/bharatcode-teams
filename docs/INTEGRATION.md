# Integration guide

## 1. Model gateway

The gateway already authenticates users with Supabase. Two calls connect it to Teams, both with
`Authorization: Bearer $INTERNAL_API_TOKEN`.

### Entitlement check

```
GET /internal/v1/entitlements/{supabaseUserId}
```

```json
{
  "userId": "6f1c…",
  "entitled": true,
  "tier": "pro",
  "orgId": "0b7e…",
  "zdr": true,
  "paidThrough": "2027-10-22T06:00:00.000Z",
  "reason": "ok"
}
```

`reason` is one of `ok`, `no_org`, `not_paid`, `expired`, `over_seat_limit`. The response carries
`Cache-Control: private, max-age=60`; cache it per user for up to a minute. Suggested gateway
logic: if the user has no individual plan and `entitled` is true, serve them at `tier`, and skip
prompt logging when `zdr` is true.

### Usage reporting

```
POST /internal/v1/usage
{
  "batchId": "gw-2026-10-22T06:05:00Z-node3",
  "events": [
    { "userId": "6f1c…", "at": "2026-10-22T06:04:12Z", "requests": 1, "inputTokens": 48211, "outputTokens": 912 }
  ]
}
```

- Send up to 5,000 events per batch, e.g. one batch per minute per gateway node.
- `batchId` makes retries safe: a repeated id returns `{"duplicate": true}` and records nothing.
- Events for users without an org seat are skipped, so the gateway can send all traffic.

## 2. Razorpay

1. Create subscription plans whose amount is the **GST-inclusive per-seat price**, since Razorpay
   charges `plan amount × quantity`:

   | Env var | Period | Amount (paise) | ₹ |
   |---|---|---|---|
   | `RAZORPAY_PLAN_TEAM_PRO_MONTHLY` | monthly, interval 1 | 117882 | 1,178.82 |

   Only this plan can stay within the ₹15,000 e-mandate limit; all other plans use payment links.
   The service checks the plan at startup and falls back to payment links if it does not match.
2. Add a webhook to `https://<host>/webhooks/razorpay` with a secret (`RAZORPAY_WEBHOOK_SECRET`)
   and these events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
   `subscription.pending`, `subscription.halted`, `subscription.cancelled`,
   `subscription.completed`, `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`.
   `subscription.authenticated` matters: it is what retires the old mandate after a seat change.
3. Watch the `billing_alerts` table (or wire it to Slack/email). Every row means money needs a
   human:

   | kind | Meaning |
   |---|---|
   | `amount_mismatch` | Paid amount differs from the quote; no invoice issued |
   | `duplicate_subscription_charge`, `payment_on_stale_checkout` | Paid on a withdrawn request; refund |
   | `provider_action_failed` | A cancellation kept failing; cancel it in the Razorpay dashboard |
   | `charge_for_past_cycle` | A second payment for a period already covered; refund (the mandate is stopped) |
   | `replacement_mandate_failed` | Seat change kept the old mandate; ask the admin to retry |
   | `unknown_*` | Webhook for an object this service did not create |
   | `renewal_*`, `invoice_build_failed` | Renewal or invoice needs manual handling |

## 3. Scheduler

Two jobs, both with the internal token (e.g. Cloud Scheduler), both safe to re-run:

- `POST /internal/v1/jobs/provider-actions` every 10 minutes. Razorpay cancellations are written to
  an outbox in the same transaction as the decision, executed immediately, and retried here with
  backoff until they succeed (or raise a `provider_action_failed` alert after 8 tries or a 4xx).
- `POST /internal/v1/jobs/renewals` once a day. It also drains the outbox, and:

- marks orgs whose period has ended as `past_due`, and
- sends one renewal payment link per period to payment-link orgs whose period ends within
  `RENEWAL_LEAD_DAYS` days.

## 4. Supabase

- Turn on "Confirm email" for email sign-ups.
- Set `SUPABASE_SERVICE_ROLE_KEY`. The service only uses it to read `email_confirmed_at` from
  `GET /auth/v1/admin/users/{id}` before domain joins, campus joins and email-bound invites.

## 5. Web app

The dashboard calls `/v1/*` with the user's Supabase access token. Allow the dashboard origin in
`CORS_ORIGINS`. The invite page lives at `${PUBLIC_APP_URL}/join?invite=<token>`: it calls
`GET /v1/invites/{token}` (no auth) to show the org name, then `POST /v1/invites/accept` after
sign-in.

| Method | Path | Who |
|---|---|---|
| GET | `/v1/plans` | anyone |
| GET | `/v1/me/orgs` | signed in |
| GET | `/v1/me/eligible-orgs` | signed in (orgs matching a verified email domain) |
| POST | `/v1/orgs` | signed in |
| GET / PATCH | `/v1/orgs/{orgId}` | member / admin |
| GET | `/v1/orgs/{orgId}/members` | admin |
| PATCH / DELETE | `/v1/orgs/{orgId}/members/{userId}` | owner / admin (or self to leave) |
| POST / GET | `/v1/orgs/{orgId}/invites` | admin |
| DELETE | `/v1/orgs/{orgId}/invites/{inviteId}` | admin |
| GET | `/v1/invites/{token}` | anyone with the link |
| POST | `/v1/invites/accept` | signed in |
| POST / GET | `/v1/orgs/{orgId}/domains` | admin |
| POST | `/v1/orgs/{orgId}/domains/{domainId}/verify` | admin |
| DELETE | `/v1/orgs/{orgId}/domains/{domainId}` | admin |
| POST | `/v1/orgs/{orgId}/join` | signed in, verified matching email |
| GET | `/v1/orgs/{orgId}/quote?plan=&seats=` | admin |
| POST | `/v1/orgs/{orgId}/checkout` | admin |
| POST | `/v1/orgs/{orgId}/seats` | admin |
| GET | `/v1/orgs/{orgId}/usage?from=&to=` | admin (max 92 days) |
| GET | `/v1/orgs/{orgId}/invoices[/{invoiceId}][?format=html]` | admin |

Errors are always `{"error": {"code", "message", "details?"}}`. A seat-limit error has code
`seat_limit_reached`.
