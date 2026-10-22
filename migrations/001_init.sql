-- BharatCode Teams: initial schema.
-- All money is stored as integer paise (bigint). All timestamps are timestamptz (UTC);
-- IST is applied only where Indian rules require it (financial year, usage day).

CREATE TABLE orgs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  kind                 text NOT NULL CHECK (kind IN ('team', 'campus')),
  billing_email        text,
  legal_name           text,
  billing_address      text,
  billing_state_code   char(2),
  gstin                char(15),
  plan_key             text,
  plan_tier            text CHECK (plan_tier IN ('lite', 'pro')),
  seat_limit           integer NOT NULL DEFAULT 0 CHECK (seat_limit >= 0),
  renewal_seats        integer CHECK (renewal_seats > 0),
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'past_due', 'cancelled')),
  collection_method    text CHECK (collection_method IN ('autopay', 'payment_link')),
  subscription_id      uuid,
  auto_renew           boolean NOT NULL DEFAULT true,
  current_period_start timestamptz,
  paid_through         timestamptz,
  domain_join_enabled  boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  email      text NOT NULL,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (org_id, user_id)
);
-- A user holds at most one active seat, so entitlement lookups are unambiguous.
CREATE UNIQUE INDEX org_members_one_active_org ON org_members (user_id) WHERE status = 'active';

CREATE TABLE org_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email       text,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  char(64) NOT NULL UNIQUE,
  max_uses    integer NOT NULL CHECK (max_uses BETWEEN 1 AND 10000),
  uses        integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (uses <= max_uses)
);
CREATE INDEX org_invites_org ON org_invites (org_id);

CREATE TABLE org_domains (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  domain             text NOT NULL,
  include_subdomains boolean NOT NULL DEFAULT false,
  verification_token text NOT NULL,
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, domain)
);
-- Once verified, a domain belongs to exactly one org.
CREATE UNIQUE INDEX org_domains_verified_unique ON org_domains (domain) WHERE verified_at IS NOT NULL;

CREATE TABLE checkouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('new_period', 'renewal', 'seat_topup')),
  method       text NOT NULL CHECK (method IN ('autopay', 'payment_link')),
  plan_key     text NOT NULL,
  seats        integer NOT NULL CHECK (seats > 0),
  quote        jsonb NOT NULL,
  total_paise  bigint NOT NULL CHECK (total_paise > 0),
  provider_ref text UNIQUE,
  short_url    text,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'paid', 'superseded', 'expired', 'cancelled')),
  renews_paid_through timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkouts_org ON checkouts (org_id, created_at DESC);
-- At most one open renewal link per org per billing period (renewal job is safe to re-run).
-- Only open rows count: a withdrawn link that is paid anyway must still be recordable as paid.
CREATE UNIQUE INDEX checkouts_one_renewal_per_period
  ON checkouts (org_id, renews_paid_through)
  WHERE purpose = 'renewal' AND status = 'pending';

CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  checkout_id              uuid REFERENCES checkouts (id),
  provider_subscription_id text NOT NULL UNIQUE,
  plan_key                 text NOT NULL,
  quantity                 integer NOT NULL CHECK (quantity > 0),
  status                   text NOT NULL,
  -- We asked Razorpay to cancel this mandate at the end of the current cycle.
  cancel_scheduled         boolean NOT NULL DEFAULT false,
  start_at                 timestamptz,
  current_start            timestamptz,
  current_end              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_org ON subscriptions (org_id);

ALTER TABLE orgs
  ADD CONSTRAINT orgs_subscription_fk FOREIGN KEY (subscription_id) REFERENCES subscriptions (id);

CREATE TABLE webhook_events (
  event_id    text PRIMARY KEY,
  -- The event-id header is not covered by the signature, so dedupe on the signed body too.
  body_sha256 char(64) NOT NULL UNIQUE,
  event       text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_alerts (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES orgs (id) ON DELETE SET NULL,
  kind       text NOT NULL,
  details    jsonb NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outbox of Razorpay cancellations: written in the deciding transaction, executed after commit,
-- retried by /internal/v1/jobs/provider-actions until done (or failed, which raises an alert).
CREATE TABLE provider_actions (
  id           bigserial PRIMARY KEY,
  org_id       uuid REFERENCES orgs (id) ON DELETE SET NULL,
  method       text NOT NULL CHECK (method IN ('autopay', 'payment_link')),
  ref          text NOT NULL,
  at_cycle_end boolean NOT NULL DEFAULT false,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  locked_until timestamptz,
  done_at      timestamptz,
  failed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_actions_open ON provider_actions (id) WHERE done_at IS NULL AND failed_at IS NULL;

CREATE TABLE invoice_sequences (
  fy       text PRIMARY KEY,
  last_seq integer NOT NULL CHECK (last_seq >= 0)
);

CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES orgs (id),
  checkout_id         uuid REFERENCES checkouts (id),
  invoice_number      text NOT NULL UNIQUE CHECK (char_length(invoice_number) <= 16),
  fy                  text NOT NULL,
  seq                 integer NOT NULL,
  issued_at           timestamptz NOT NULL,
  provider_payment_id text NOT NULL UNIQUE,
  supplier            jsonb NOT NULL,
  recipient           jsonb NOT NULL,
  place_of_supply     char(2) NOT NULL,
  supply_type         text NOT NULL CHECK (supply_type IN ('intra', 'inter')),
  lines               jsonb NOT NULL,
  taxable_paise       bigint NOT NULL,
  cgst_paise          bigint NOT NULL,
  sgst_paise          bigint NOT NULL,
  igst_paise          bigint NOT NULL,
  total_paise         bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fy, seq),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise)
);
CREATE INDEX invoices_org ON invoices (org_id, issued_at DESC);

CREATE TABLE usage_batches (
  batch_id    text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_daily (
  org_id        uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  day           date NOT NULL,
  requests      bigint NOT NULL DEFAULT 0,
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, day)
);
CREATE INDEX usage_daily_org_day ON usage_daily (org_id, day);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES orgs (id) ON DELETE CASCADE,
  actor      uuid,
  action     text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org ON audit_log (org_id, created_at DESC);
CREATE INDEX webhook_events_received ON webhook_events (received_at);
CREATE INDEX usage_batches_received ON usage_batches (received_at);
