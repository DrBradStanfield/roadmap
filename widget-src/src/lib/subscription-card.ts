/**
 * The subscription change card (US-59): what the chat server sends when the
 * model proposed pausing, skipping or cancelling one of a logged-in customer's
 * subscriptions, the confirm call, and the plain words for each outcome.
 * Shopify commerce surface only; the server sends no card anywhere else.
 * The card's token is the gateway's: one use, 10 minutes, bound to this
 * customer and this subscription as it was when shown. It is kept in memory
 * for this tab only, never written to chat history or synced to other tabs.
 */
import { PROXY_PATH, parseJsonResponse } from './server-api';

export type SubscriptionCardAction = 'pause' | 'skip' | 'cancel';

export interface SubscriptionCard {
  token: string;
  action: SubscriptionCardAction;
  product: string;
  every: string | null;
  nextDate: string | null;
  newDate: string | null;
  reason: string | null;
  paused: boolean;
}

export interface SubscriptionResult { status: 'done' | 'accepted' | 'unconfirmed' | 'refused'; code?: string; newDate?: string }

const ACTIONS: readonly string[] = ['pause', 'skip', 'cancel'];
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/** The card from a chat reply, or null when it is missing or malformed. */
export function readSubscriptionCard(value: unknown): SubscriptionCard | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const token = str(v.token, 1300);
  const product = str(v.product);
  if (!token || !product || !ACTIONS.includes(v.action as string)) return null;
  return {
    token,
    action: v.action as SubscriptionCardAction,
    product,
    every: str(v.every, 40),
    nextDate: str(v.nextDate, 60),
    newDate: str(v.newDate, 60),
    reason: str(v.reason, 40),
    paused: v.status === 'paused',
  };
}

/** Post the customer's confirm. Never throws: a network failure is an unconfirmed result. */
export async function confirmSubscriptionChange(card: SubscriptionCard): Promise<SubscriptionResult> {
  try {
    const response = await fetch(`${PROXY_PATH}/api/subscription-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: card.token, ...(card.reason ? { reason: card.reason } : {}) }),
    });
    const data = await parseJsonResponse<{ status?: string; code?: string; newDate?: string }>(response).catch(() => null);
    const status = data?.status;
    if (status === 'done' || status === 'accepted' || status === 'unconfirmed' || status === 'refused') {
      return { status, ...(data?.code ? { code: data.code } : {}), ...(data?.newDate ? { newDate: data.newDate } : {}) };
    }
    return { status: 'unconfirmed' };
  } catch {
    return { status: 'unconfirmed' };
  }
}

// ── Words (US-59; drafted for Brad's review before going live) ──
export const SUBSCRIPTION_HELP_LINE =
  "You can change it in your account at https://account.microvitamin.com/, or email brad@microvitamin.com and we'll sort it out.";

export function cardTitle(action: SubscriptionCardAction): string {
  return action === 'pause' ? 'Pause this subscription?' : action === 'skip' ? 'Skip the next order?' : 'Cancel this subscription?';
}

/** The card's fact lines, plain. */
export function cardLines(card: SubscriptionCard): string[] {
  const lines = [card.every ? `${card.product}, every ${card.every}` : card.product];
  // A paused subscription has no next order to show, and pausing it is no alternative (live pilot, 18 Oct).
  if (card.paused) lines.push('Paused');
  else if (card.action === 'skip' && card.nextDate && card.newDate) lines.push(`Your next order moves from ${card.nextDate} to ${card.newDate}.`);
  else if (card.nextDate) lines.push(`Next order: ${card.nextDate}`);
  if (card.action === 'cancel') lines.push(card.paused ? "Cancelling can't be undone." : "Cancelling can't be undone. You could pause it instead.");
  return lines;
}

const EXPIRED = new Set(['expired', 'used', 'changed', 'invalid']);
export function resultText(card: SubscriptionCard, r: SubscriptionResult): string {
  if (r.status === 'done') {
    if (card.action === 'pause') return 'Done. Your subscription is paused.';
    if (card.action === 'cancel') return 'Done. Your subscription is cancelled.';
    return `Done. Your next order is now on ${r.newDate ?? card.newDate}.`;
  }
  if (r.status === 'accepted') return 'The change has been accepted and should show in your account within a few minutes.';
  if (r.status === 'unconfirmed') return `We couldn't confirm the change. Please check your account in a few minutes. ${SUBSCRIPTION_HELP_LINE}`;
  // Every refusal ends with where to go instead (US-59 AC8).
  if (r.code && EXPIRED.has(r.code)) return `This card is out of date. Ask in the chat again for a fresh one. ${SUBSCRIPTION_HELP_LINE}`;
  if (r.code === 'busy') return `The store is busy. Please try again in a minute. ${SUBSCRIPTION_HELP_LINE}`;
  if (r.code === 'open_order') return `An order for this subscription has already been placed, and this change wouldn't alter it, so it can't be made here. ${SUBSCRIPTION_HELP_LINE}`;
  if (r.code === 'held_unresolved') return `A recent change to this subscription is still being checked, so it can't be changed here yet. ${SUBSCRIPTION_HELP_LINE}`;
  return `That change can't be made here. ${SUBSCRIPTION_HELP_LINE}`;
}
