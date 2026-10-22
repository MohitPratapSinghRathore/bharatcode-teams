import { createHmac } from 'node:crypto';
import { safeEqual } from './auth.js';

export interface CreateSubscriptionInput {
  planId: string;
  quantity: number;
  totalCount: number;
  /** Unix seconds; omit to start on authorisation. */
  startAt?: number;
  notes: Record<string, string>;
}

export interface CreatePaymentLinkInput {
  amountPaise: number;
  description: string;
  /** Unique per link on Razorpay's side, which makes accidental double-creation fail loudly. */
  referenceId: string;
  customer: { name?: string; email?: string };
  /** Unix seconds. */
  expireBy: number;
  notes: Record<string, string>;
}

export interface RazorpayApi {
  createSubscription(input: CreateSubscriptionInput): Promise<{ id: string; shortUrl: string; status: string }>;
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<void>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<{ id: string; shortUrl: string }>;
  cancelPaymentLink(id: string): Promise<void>;
  fetchPlan(id: string): Promise<{ amountPaise: number; currency: string; period: string; interval: number }>;
}

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

interface RazorpayErrorBody {
  error?: { code?: string; description?: string };
}

export function createRazorpayClient(opts: {
  keyId: string;
  keySecret: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): RazorpayApi {
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`;

  // POSTs here create money-moving objects, so they are never retried automatically.
  async function call<T>(method: 'POST' | 'GET', path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${opts.apiBase}/v1${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error page; handled below.
    }
    if (!res.ok) {
      const err = (json as RazorpayErrorBody | null)?.error;
      throw new RazorpayError(res.status, err?.code, err?.description ?? `Razorpay request failed (${res.status})`);
    }
    return json as T;
  }

  return {
    async createSubscription(input) {
      const res = await call<{ id: string; short_url: string; status: string }>('POST', '/subscriptions', {
        plan_id: input.planId,
        total_count: input.totalCount,
        quantity: input.quantity,
        customer_notify: 1,
        ...(input.startAt === undefined ? {} : { start_at: input.startAt }),
        notes: input.notes,
      });
      return { id: res.id, shortUrl: res.short_url, status: res.status };
    },
    async cancelSubscription(id, atCycleEnd) {
      await call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {
        cancel_at_cycle_end: atCycleEnd ? 1 : 0,
      });
    },
    async createPaymentLink(input) {
      const res = await call<{ id: string; short_url: string }>('POST', '/payment_links', {
        amount: input.amountPaise,
        currency: 'INR',
        accept_partial: false,
        description: input.description.slice(0, 2048),
        reference_id: input.referenceId,
        customer: input.customer,
        notify: { sms: false, email: Boolean(input.customer.email) },
        reminder_enable: true,
        expire_by: input.expireBy,
        notes: input.notes,
      });
      return { id: res.id, shortUrl: res.short_url };
    },
    async cancelPaymentLink(id) {
      await call('POST', `/payment_links/${encodeURIComponent(id)}/cancel`, {});
    },
    async fetchPlan(id) {
      const res = await call<{ period: string; interval: number; item: { amount: number; currency: string } }>(
        'GET',
        `/plans/${encodeURIComponent(id)}`,
      );
      return { amountPaise: res.item.amount, currency: res.item.currency, period: res.period, interval: res.interval };
    },
  };
}

/** Razorpay signs the raw webhook body with HMAC-SHA256 (hex) using the webhook secret. */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(expected, signature.trim().toLowerCase());
}

export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}
