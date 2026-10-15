// @vitest-environment jsdom
/**
 * US-49 AC8: the confirm card. Nothing changes until Confirm; the outcome is
 * shown in plain words; the token is posted with a code-only reason.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { SubscriptionChangeCard } from './SubscriptionChangeCard';
import { readSubscriptionCard, confirmSubscriptionChange, resultText, SUBSCRIPTION_HELP_LINE, type SubscriptionCard } from '../lib/subscription-card';

const skip: SubscriptionCard = { token: 'tok-skip-S1-xxxxxxxxxxxxxxxx', action: 'skip', product: 'MicroVitamin', every: '3 months', nextDate: '6 January 2027', newDate: '6 April 2027', reason: null };
const cancel: SubscriptionCard = { ...skip, token: 'tok-cancel-S1-xxxxxxxxxxxxxxx', action: 'cancel', newDate: null, reason: 'too_expensive' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('US-49 AC8 — SubscriptionChangeCard', () => {
  it('idle: the facts, Confirm and Not now; nothing happens until pressed', () => {
    const onConfirm = vi.fn(); const onDismiss = vi.fn();
    const { getByText, getByRole } = render(<SubscriptionChangeCard entry={{ card: skip, phase: 'idle' }} onConfirm={onConfirm} onDismiss={onDismiss} />);
    expect(getByText('Skip the next order?')).toBeTruthy();
    expect(getByText('Your next order moves from 6 January 2027 to 6 April 2027.')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('cancel says it cannot be undone; sending disables both buttons', () => {
    const { getByText, getByRole } = render(<SubscriptionChangeCard entry={{ card: cancel, phase: 'sending' }} onConfirm={vi.fn()} onDismiss={vi.fn()} />);
    expect(getByText("Cancelling can't be undone. You could pause it instead.")).toBeTruthy();
    expect((getByRole('button', { name: 'Working…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole('button', { name: 'Not now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closed: the outcome, and no buttons', () => {
    const { getByRole, queryByRole } = render(<SubscriptionChangeCard entry={{ card: skip, phase: 'closed', result: { status: 'done', newDate: '6 April 2027' } }} onConfirm={vi.fn()} onDismiss={vi.fn()} />);
    expect(getByRole('status').textContent).toBe('Done. Your next order is now on 6 April 2027.');
    expect(queryByRole('button')).toBeNull();
  });
});

describe('US-49 AC8 — subscription-card helpers', () => {
  it('reads only a well-formed card', () => {
    expect(readSubscriptionCard(skip)).toEqual(skip);
    expect(readSubscriptionCard({ ...skip, action: 'monthly' })).toBeNull();
    expect(readSubscriptionCard({ ...skip, token: '' })).toBeNull();
    expect(readSubscriptionCard('x')).toBeNull();
  });

  it('Codex C4: every refusal and every unconfirmed outcome ends with where to go; stale cards also say ask again', () => {
    const codes = ['expired', 'used', 'changed', 'invalid', 'busy', 'held_unresolved', 'off_policy', 'not_active', 'near_billing', 'customer_limit',
      'contract_limit', 'skip_limit', 'open_order', 'store_limit', 'email_in_flight', 'chat_in_flight', 'live_unreadable', 'unavailable', 'appstle_refused', 'not_enabled', undefined];
    for (const code of codes) expect(resultText(cancel, { status: 'refused', ...(code ? { code } : {}) }).endsWith(SUBSCRIPTION_HELP_LINE)).toBe(true);
    expect(resultText(cancel, { status: 'unconfirmed' }).endsWith(SUBSCRIPTION_HELP_LINE)).toBe(true);
    expect(resultText(cancel, { status: 'refused', code: 'used' })).toBe(`This card is out of date. Ask in the chat again for a fresh one. ${SUBSCRIPTION_HELP_LINE}`);
    expect(resultText(cancel, { status: 'refused', code: 'held_unresolved' })).toMatch(/^A recent change to this subscription is still being checked/);
    expect(resultText(cancel, { status: 'refused', code: 'open_order' })).toMatch(/^An order for this subscription has already been placed/);
    expect(resultText(cancel, { status: 'done' })).toBe('Done. Your subscription is cancelled.');
    for (const r of [{ status: 'done' }, { status: 'accepted' }, { status: 'unconfirmed' }, { status: 'refused' }] as const) expect(resultText(cancel, r)).not.toMatch(/urgent/i);
  });

  it('posts the token and the reason code as JSON to the app proxy; a network failure is unconfirmed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, status: 'done' }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await confirmSubscriptionChange(cancel)).toEqual({ status: 'done' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/apps/health-tool-1/api/subscription-action');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ token: cancel.token, reason: 'too_expensive' });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await confirmSubscriptionChange(cancel)).toEqual({ status: 'unconfirmed' });
  });
});
