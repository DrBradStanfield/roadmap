/**
 * US-59 AC7: the real getChatCompletion offers the propose-only subscription
 * tool only when asked, and a tool-only answer gets a short line, never a
 * fallback. Only the network is stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { getChatCompletion, SUBSCRIPTION_TOOL_ONLY_ACK } from './chat.server';

function stubAnthropic(content: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
}
afterEach(() => { vi.unstubAllGlobals(); });

const proposal = { type: 'tool_use', id: 'tu_1', name: 'propose_subscription_change', input: { subscription: 'S1', action: 'pause', reason: 'taking_a_break' } };
const messages = [{ role: 'user' as const, content: 'Pause my subscription, I am travelling' }];

describe('US-59 AC7 — the subscription tool in getChatCompletion', () => {
  it('offered only with subscriptionTool; a tool-only answer is a short line plus the proposal', async () => {
    const bodies = stubAnthropic([proposal]);
    const r = await getChatCompletion([], messages, false, undefined, { subscriptionTool: true });
    expect(bodies()[0].tools.map((t: { name: string }) => t.name)).toEqual(['propose_subscription_change']);
    expect(r.isFallback).toBe(false);
    expect(r.content).toBe(SUBSCRIPTION_TOOL_ONLY_ACK);
    expect(r.subscriptionProposal).toEqual({ ref: 'S1', action: 'pause', reason: 'taking_a_break' });
  });

  it('without it: no tools at all, and a stray proposal is ignored', async () => {
    const bodies = stubAnthropic([{ type: 'text', text: 'An answer.' }, proposal]);
    const r = await getChatCompletion([], messages, false);
    expect(bodies()[0]).not.toHaveProperty('tools');
    expect(r.subscriptionProposal).toBeUndefined();
  });

  it('with the form tools too, both are sent', async () => {
    const bodies = stubAnthropic([{ type: 'text', text: 'Press Confirm below.' }, proposal]);
    const r = await getChatCompletion([], messages, true, undefined, { subscriptionTool: true, profileEdits: true });
    expect(bodies()[0].tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit', 'propose_subscription_change']);
    expect(r.content).toBe('Press Confirm below.');
    expect(r.subscriptionProposal?.action).toBe('pause');
  });

  it('Codex C5: a tool-only answer with a form edit AND a subscription proposal keeps both', async () => {
    stubAnthropic([{ type: 'tool_use', id: 'tu_0', name: 'propose_field_edit', input: { field: 'weightKg', value: 80, unit: 'kg' } }, proposal]);
    const r = await getChatCompletion([], messages, true, undefined, { subscriptionTool: true });
    expect(r.proposedEdits).toHaveLength(1);
    expect(r.subscriptionProposal).toEqual({ ref: 'S1', action: 'pause', reason: 'taking_a_break' });
  });
});
