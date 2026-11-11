// @vitest-environment jsdom
/**
 * US-15 AC62: a floating chat opened after an erase (a fresh ChatSection at
 * the page's new erase) never mirrors another tab's conversation from a sender
 * that names no erase (the site bubble and the chatbot embed send null, an
 * older bundle sends none); it still shows that sender's busy state. A sender
 * at the same erase still shares its conversation. The real hook runs; the
 * chat's network and the cross-tab channel are stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('@sentry/react', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/chat-history-access', () => ({ chatMark: () => '', stillMarked: () => true, getChatHistory: () => Promise.resolve(null) }));
vi.mock('../lib/server-api', async (original) => ({
  ...await original<typeof import('../lib/server-api')>(),
  trackProductEvent: vi.fn(),
}));
const sync = vi.hoisted(() => ({ hear: null as null | ((msg: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'test',
  subscribeSync: (hear: (msg: unknown) => void) => { sync.hear = hear; return () => {}; },
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./ChatThreadList', () => ({ ChatThreadList: () => null }));

import { ChatSection } from './ChatSection';

const ERASE = 'synthetic-erase-2';
const state = (erase: string | null | undefined, busy = false) => ({
  instanceId: 'other-tab', type: 'state', ts: Date.now(),
  payload: {
    conversations: [{ id: 'conv-1', title: 'First', updatedAt: 'x', createdAt: 'x' }], activeConversationId: 'conv-1',
    messages: [{ id: 'q', role: 'user', content: 'A question from the other tab', createdAt: 'x' }],
    isLoading: busy, sending: busy, error: null, ...(erase !== undefined ? { erase } : {}),
  },
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, conversations: [] }), { headers: { 'Content-Type': 'application/json' } })));
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const openFloating = () => render(<ChatSection isLoggedIn startExpanded erase={{ shown: ERASE, erasing: false }} />);

describe('US-15 AC62: a floating chat opened after an erase', () => {
  it.each([['null', null], ['absent', undefined]] as const)('a sender with no erase (%s): nothing mirrors in', (_label, erase) => {
    const { container } = openFloating();
    act(() => sync.hear!(state(erase)));
    expect(container.textContent).not.toContain('A question from the other tab');
  });

  it('a null sender\'s busy state still shows', () => {
    const { container } = openFloating();
    act(() => sync.hear!(state(null, true)));
    expect(container.querySelector<HTMLTextAreaElement>('textarea.chat-input')!.disabled).toBe(true);
    expect(container.textContent).not.toContain('A question from the other tab');
  });

  it('control: a sender at the same erase shares its conversation', () => {
    const { container } = openFloating();
    act(() => sync.hear!(state(ERASE)));
    expect(container.textContent).toContain('A question from the other tab');
  });
});
