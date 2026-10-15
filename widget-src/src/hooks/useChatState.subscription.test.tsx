// @vitest-environment jsdom
/**
 * US-49 AC9: a reply's subscription card lives with that answer in this tab
 * only; Confirm sends once however often it is pressed; a busy store leaves
 * the card open. (The usage signal is the server's: api.subscription-action.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { SubscriptionCard } from '../lib/subscription-card';

const card: SubscriptionCard = { token: 'tok-pause-S1-xxxxxxxxxxxxxxxx', action: 'pause', product: 'MicroVitamin', every: '3 months', nextDate: '6 January 2027', newDate: null, reason: null };
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), postSync: vi.fn() }));
vi.mock('../lib/chat-api', () => ({
  sendMessage: vi.fn(async () => ({ result: { conversationId: 'c1', messageId: 'm1', content: 'Press Confirm below to pause it.', subscriptionCard: card }, error: null })),
  listConversations: vi.fn(), loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../lib/subscription-card', () => ({ confirmSubscriptionChange: mocks.confirm }));
vi.mock('../lib/chat-sync', () => ({ postSync: mocks.postSync, postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));

import { useChatState } from './useChatState';

async function withCard() {
  const hook = renderHook(() => useChatState({ isLoggedIn: true }));
  act(() => hook.result.current.actions.handleInputChange('Pause my subscription'));
  await act(async () => { await hook.result.current.actions.handleSend(); });
  return hook;
}

beforeEach(() => { mocks.confirm.mockReset(); mocks.postSync.mockReset(); });

describe('US-49 AC9 — subscription cards in useChatState', () => {
  it('the card sits with its answer, and is never synced to other tabs', async () => {
    const hook = await withCard();
    expect(hook.result.current.state.cardsById.m1).toEqual({ card, phase: 'idle' });
    expect(JSON.stringify(mocks.postSync.mock.calls)).not.toContain(card.token);
  });

  it('Confirm sends once and closes on the outcome', async () => {
    const hook = await withCard();
    let resolve!: (v: unknown) => void;
    mocks.confirm.mockReturnValue(new Promise((r) => { resolve = r; }));
    let first!: Promise<void>;
    act(() => { first = hook.result.current.actions.confirmSubscription('m1'); void hook.result.current.actions.confirmSubscription('m1'); });
    expect(hook.result.current.state.cardsById.m1.phase).toBe('sending');
    await act(async () => { resolve({ status: 'done' }); await first; });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state.cardsById.m1).toMatchObject({ phase: 'closed', result: { status: 'done' } });
  });

  it('busy leaves it open to try again; a refusal closes it', async () => {
    const hook = await withCard();
    mocks.confirm.mockResolvedValueOnce({ status: 'refused', code: 'busy' });
    await act(async () => { await hook.result.current.actions.confirmSubscription('m1'); });
    expect(hook.result.current.state.cardsById.m1.phase).toBe('idle');
    mocks.confirm.mockResolvedValueOnce({ status: 'refused', code: 'off_policy' });
    await act(async () => { await hook.result.current.actions.confirmSubscription('m1'); });
    expect(hook.result.current.state.cardsById.m1.phase).toBe('closed');
  });

  it('Not now closes it and sends nothing', async () => {
    const hook = await withCard();
    act(() => hook.result.current.actions.dismissSubscription('m1'));
    expect(hook.result.current.state.cardsById.m1).toMatchObject({ phase: 'closed', dismissed: true });
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
