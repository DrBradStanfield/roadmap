/**
 * Subscription changes in the website chat (US-59): the chatbot's thin door
 * to the private customer-service gateway, which holds the Appstle key, every
 * eligibility rule, the write, its read-back and the decision log. Nothing here
 * changes a subscription: this file reads the customer's summary, offers the
 * model one tool to PROPOSE a change, turns a proposal into a confirm card,
 * and forwards the customer's own confirm.
 *
 * Commerce only. `subscriptionActionsEnabled()` needs CHAT_SUBSCRIPTION_ACTIONS=on,
 * CHAT_SURFACE=brand (microvitamin.com, health-tool-app), the gateway URL and
 * the shared secret. The education app (health-tool-edu, drstanfield.com)
 * never has them, so it never shows or proposes anything. The gateway has its
 * own switch too (CHAT_SUBSCRIPTION_MODE off | pilot | live, default off).
 *
 * Identity: the gateway trusts no customer id from here. Every call forwards
 * the app-proxy query Shopify signed on the customer's own request, and the
 * gateway checks that signature itself; this server also signs each call
 * (HMAC over method, path, timestamp, one-time value and body) with
 * CHAT_GATEWAY_SECRET. Tokens on cards are minted by the gateway, bound to the
 * customer, contract, action and the contract's state, single use, 10 minutes.
 *
 * Privacy: no address, price or payment detail is read; tokens never enter the
 * model's context or any log; failures are logged as fixed strings.
 */
import crypto from 'crypto';
import * as Sentry from '@sentry/react-router';

export const SUBSCRIPTION_ACTIONS = ['pause', 'skip', 'cancel'] as const;
export type SubscriptionActionName = (typeof SUBSCRIPTION_ACTIONS)[number];
/** Why a customer cancels or pauses, as a code only; the gateway keeps the same list. */
export const SUBSCRIPTION_REASONS = ['too_expensive', 'have_enough', 'side_effects', 'no_difference', 'switching', 'taking_a_break', 'other'] as const;
export type SubscriptionReason = (typeof SUBSCRIPTION_REASONS)[number];

export interface SubscriptionActionState { ok: boolean; code?: string; token?: string; newDate?: string }
export interface SubscriptionEntry {
  ref: string;
  product: string;
  status: 'active' | 'paused';
  every: string | null;
  onPolicy: boolean;
  nextDate: string | null;
  actions: Record<SubscriptionActionName, SubscriptionActionState>;
}
export interface SubscriptionSummary { enabled: boolean; subscriptions?: SubscriptionEntry[]; note?: string; error?: string }

/** What the widget shows and posts back: the gateway's token and plain facts. */
export interface SubscriptionCard {
  token: string;
  action: SubscriptionActionName;
  product: string;
  every: string | null;
  nextDate: string | null;
  newDate: string | null;
  reason: SubscriptionReason | null;
  /** 'paused': the card shows "Paused" and no pause hint (live pilot, 18 Oct). */
  status: 'active' | 'paused';
}
export interface SubscriptionProposal { ref: string; action: SubscriptionActionName; reason: SubscriptionReason | null }

/** The line every "can't do it here" ends with (plan section 7, "When it can't"). */
export const SUBSCRIPTION_HELP_LINE =
  'You can change it in your account at https://account.microvitamin.com/, or email brad@microvitamin.com and we\'ll sort it out.';

export function subscriptionActionsEnabled(): boolean {
  return process.env.CHAT_SUBSCRIPTION_ACTIONS === 'on'
    && process.env.CHAT_SURFACE === 'brand'
    && /^https?:\/\//.test(process.env.CS_GATEWAY_CHAT_URL ?? '')
    && (process.env.CHAT_GATEWAY_SECRET ?? '').length >= 32;
}

/** The app-proxy query exactly as Shopify signed it (repeated keys kept). */
export function proxyParams(request: Request): Record<string, string[]> {
  const params = new URL(request.url).searchParams;
  const out: Record<string, string[]> = {};
  for (const key of new Set(params.keys())) out[key] = params.getAll(key);
  return out;
}

/** The gateway's canonical string (customer-service-gateway src/chat/auth.js canonical). */
export function signGatewayRequest(
  { method, path, body, secret, now = Date.now(), nonce = crypto.randomBytes(16).toString('hex') }:
  { method: string; path: string; body: string; secret: string; now?: number; nonce?: string },
): Record<string, string> {
  const ts = String(now);
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto.createHmac('sha256', secret).update([method.toUpperCase(), path, ts, nonce, bodyHash].join('\n')).digest('hex');
  return { 'x-gateway-timestamp': ts, 'x-gateway-nonce': nonce, 'x-gateway-signature': signature };
}

async function callGateway(path: string, payload: object, timeoutMs: number): Promise<any | null> {
  const body = JSON.stringify(payload);
  const base = String(process.env.CS_GATEWAY_CHAT_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...signGatewayRequest({ method: 'POST', path, body, secret: String(process.env.CHAT_GATEWAY_SECRET) }) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // A 403 is a logged-out or unsigned customer: expected, not an error.
      if (res.status !== 403) reportGatewayError(`Subscription gateway: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data && data.ok === true ? data : null;
  } catch {
    reportGatewayError('Subscription gateway: request failed');
    return null;
  }
}

// Fixed strings only: nothing the customer typed or the gateway answered.
function reportGatewayError(message: string): void {
  console.error(message);
  Sentry.captureMessage(message, { level: 'warning', tags: { feature: 'chat_subscriptions' } });
}

// The summary, per customer, for 1 minute (tokens last 10). Invalidated after any confirm. The cache
// is per machine: with several health-tool-app machines a customer may see a summary up to a minute old
// on another one; the gateway's own checks (live Appstle read, token bound to the state) catch any change.
const SUMMARY_TTL = 60_000;
const summaryCache = new Map<string, { summary: SubscriptionSummary; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of summaryCache) if (now > entry.expiresAt) summaryCache.delete(key);
}, 5 * 60_000).unref?.();

/** The logged-in customer's subscription summary, or null (off, logged out, or the gateway failed). Never throws. */
export async function getCachedSubscriptions(request: Request, customerId: string): Promise<SubscriptionSummary | null> {
  if (!subscriptionActionsEnabled()) return null;
  const cached = summaryCache.get(customerId);
  if (cached && Date.now() < cached.expiresAt) return cached.summary;
  const data = await callGateway('/chat/subscriptions', { proxy: proxyParams(request) }, 4000);
  if (!data || data.enabled !== true) return null;
  const summary: SubscriptionSummary = {
    enabled: true,
    subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
    ...(typeof data.note === 'string' ? { note: data.note } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
  };
  summaryCache.set(customerId, { summary, expiresAt: Date.now() + SUMMARY_TTL });
  return summary;
}

export function invalidateSubscriptions(customerId: string): void { summaryCache.delete(customerId); }

const ACTION_LINE: Record<SubscriptionActionName, string> = { pause: 'pause', skip: 'skip the next order', cancel: 'cancel' };
const NO_REASON: Record<string, string> = {
  off_policy: 'not every 3 or 6 months',
  not_active: 'not active',
  near_billing: 'the next order is being processed',
  email_in_flight: 'a change is already in progress',
  chat_in_flight: 'a change is already in progress',
  held_unresolved: 'a recent change is still being checked',
  open_order: 'an order has already been placed and is not yet shipped; this change would not alter it, so send them to email',
  customer_limit: 'change limit reached for today',
  contract_limit: 'changed in the last hour',
  skip_limit: 'skipped too often recently',
  store_limit: 'busy',
  busy: 'busy',
  unavailable: 'unavailable right now',
};

/**
 * The model's view of the summary: facts and which changes it may propose.
 * Never the tokens. It is a per-request block, after the cached base, so it
 * changes no cached prefix, and it carries the rules for this surface only.
 */
export function formatSubscriptionBlock(summary: SubscriptionSummary): string {
  const subs = summary.subscriptions ?? [];
  const head = '## Your Subscriptions\n\nThe signed-in customer\'s subscriptions, read live from the store. Use only these facts.\n\n';
  if (summary.error || summary.note === 'unavailable') {
    return `${head}They could not be read right now. For any subscription change, say you can't do it here right now and give this line: "${SUBSCRIPTION_HELP_LINE}"`;
  }
  if (!subs.length) return `${head}The customer has no active or paused subscription.`;
  const lines = subs.map((s) => {
    const can = SUBSCRIPTION_ACTIONS.map((a) => {
      const st = s.actions?.[a];
      if (st?.ok) return `${ACTION_LINE[a]}: yes${a === 'skip' && st.newDate ? ` (moves it to ${st.newDate})` : ''}`;
      return `${ACTION_LINE[a]}: no (${NO_REASON[st?.code ?? ''] ?? 'not possible here'})`;
    }).join('; ');
    return `- ${s.ref}: ${s.product}, ${s.every ? `every ${s.every}` : 'interval unknown'}, ${s.status}${s.nextDate ? `, next order ${s.nextDate}` : ''}. Can ${can}.`;
  });
  return `${head}${lines.join('\n')}

### Changing one of these subscriptions (this replaces the earlier "Subscription changes" line for the subscriptions listed here)

- You can set up three changes for the customer to confirm: pause a subscription, skip its next order, or cancel it. When the customer clearly asks for one of these for a subscription listed above, and it shows "yes", call \`propose_subscription_change\` with its ref and the action. If they have more than one subscription and it is not clear which one they mean, ask which first.
- You never make the change. A card appears under your reply and the change happens only if the customer presses Confirm on it. Say so in one short line, such as "Press Confirm below to pause it." Never say it is done.
- A skip moves only the next order, one delivery interval later. Deliveries are every 3 or every 6 months only: never offer monthly deliveries, an earlier date, a date of their choosing, a different frequency, restarting a paused subscription, a product swap or a quantity change here.
- If they ask for monthly deliveries, another frequency or an earlier order date, say plainly that deliveries are every 3 or every 6 months and an order date can only move later. Do not point them to their account to do it, and do not give the line below.
- When a change shows "no", or they ask for anything else about a subscription (an address, a card, a product), say plainly that you can't do it here and give this line: "${SUBSCRIPTION_HELP_LINE}"
- You cannot see whether the customer pressed Confirm on an earlier card, and this list can lag a change by up to a minute. Never say an earlier card is still waiting, and never tell them not to press Confirm on one. If they ask what happened, say the card shows the result and their account at https://account.microvitamin.com/ has the current date.
- A reply that is only about their subscription needs no line about medical advice at the end.
- If they say why they want to cancel or pause, pass the closest reason code. Never ask them why.`;
}

/** Tool: propose ONE change. Sent on every brand-surface turn while enabled, so the cached prefix stays one shape. */
export const PROPOSE_SUBSCRIPTION_CHANGE_TOOL = {
  name: 'propose_subscription_change',
  description:
    "Show the signed-in customer a card to confirm ONE change to ONE of their subscriptions listed under 'Your Subscriptions': " +
    'pause it, skip its next order, or cancel it. The change happens only if the customer presses Confirm on the card; you never make it. ' +
    'Use ONLY when the customer clearly asks for that change, and only for a subscription and action marked "yes" in that list. ' +
    'Never use it when there is no "Your Subscriptions" list.',
  input_schema: {
    type: 'object' as const,
    properties: {
      subscription: { type: 'string' as const, description: "The subscription's ref from the list, e.g. 'S1'." },
      action: { type: 'string' as const, enum: [...SUBSCRIPTION_ACTIONS] },
      reason: {
        type: 'string' as const,
        enum: [...SUBSCRIPTION_REASONS],
        description: 'Only for cancel or pause, and only if the customer said why. Omit otherwise.',
      },
    },
    required: ['subscription', 'action'],
  },
} as const;

/** The first valid proposal among the model's tool calls, or null. */
export function parseSubscriptionProposal(blocks: Array<{ type: string; name?: string; input?: unknown }>): SubscriptionProposal | null {
  for (const b of blocks) {
    if (b.type !== 'tool_use' || b.name !== PROPOSE_SUBSCRIPTION_CHANGE_TOOL.name) continue;
    const input = (b.input ?? {}) as Record<string, unknown>;
    const ref = typeof input.subscription === 'string' && /^S\d{1,2}$/.test(input.subscription) ? input.subscription : null;
    const action = (SUBSCRIPTION_ACTIONS as readonly unknown[]).includes(input.action) ? input.action as SubscriptionActionName : null;
    if (!ref || !action) continue;
    const reason = action !== 'skip' && (SUBSCRIPTION_REASONS as readonly unknown[]).includes(input.reason) ? input.reason as SubscriptionReason : null;
    return { ref, action, reason };
  }
  return null;
}

/** A card for the proposal, only when the summary lists that subscription and that action with a token. */
export function subscriptionCard(summary: SubscriptionSummary | null, proposal: SubscriptionProposal | null): SubscriptionCard | null {
  if (!summary || !proposal) return null;
  const s = (summary.subscriptions ?? []).find((x) => x.ref === proposal.ref);
  const st = s?.actions?.[proposal.action];
  if (!s || !st?.ok || typeof st.token !== 'string') return null;
  return {
    token: st.token,
    action: proposal.action,
    product: s.product,
    every: s.every,
    nextDate: s.nextDate,
    newDate: st.newDate ?? null,
    reason: proposal.reason,
    status: s.status === 'paused' ? 'paused' : 'active',
  };
}

/**
 * The customer's confirm, forwarded: the gateway's { status, code?, newDate? }.
 * A gateway that refused the request itself (4xx: unsigned, logged out) is a
 * refusal, nothing written. A timeout, a network error or a 5xx is
 * `unconfirmed`: the gateway may have made the change and lost the answer.
 */
export async function postSubscriptionAction(
  request: Request,
  token: string,
  reason: SubscriptionReason | null,
): Promise<{ status: string; code?: string; newDate?: string }> {
  const body = JSON.stringify({ proxy: proxyParams(request), token, ...(reason ? { reason } : {}) });
  const path = '/chat/subscription-action';
  const base = String(process.env.CS_GATEWAY_CHAT_URL).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...signGatewayRequest({ method: 'POST', path, body, secret: String(process.env.CHAT_GATEWAY_SECRET) }) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    reportGatewayError('Subscription gateway: confirm request failed');
    return { status: 'unconfirmed' };
  }
  if (res.status >= 500) { reportGatewayError(`Subscription gateway: HTTP ${res.status}`); return { status: 'unconfirmed' }; }
  if (!res.ok) { reportGatewayError(`Subscription gateway: HTTP ${res.status}`); return { status: 'refused', code: 'unavailable' }; }
  let data: any = null;
  try { data = await res.json(); } catch { return { status: 'unconfirmed' }; }
  if (!data || data.ok !== true || typeof data.status !== 'string') return { status: 'unconfirmed' };
  return {
    status: data.status,
    ...(typeof data.code === 'string' ? { code: data.code } : {}),
    ...(typeof data.newDate === 'string' ? { newDate: data.newDate } : {}),
  };
}
