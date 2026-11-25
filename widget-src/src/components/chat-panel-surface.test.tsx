// @vitest-environment jsdom
/**
 * US-15 AC77: the inline chat panel (ChatEmbed) takes its words by the pop-up's
 * rule, the store's chat surface, from the same table, and a panel shown is
 * counted as `chat_panel_shown`, name only, while the pop-up keeps `chat_opened`.
 * Synthetic chat; the hook's real behaviour has its own tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const seen = vi.hoisted(() => ({ visible: true }));
vi.mock('../lib/chat-sync', () => ({
  generateInstanceId: () => 'tab', postInputSync: vi.fn(), postSync: vi.fn(), subscribeSync: () => () => {},
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null, sendMessage: vi.fn(), deleteConversation: vi.fn(), loadConversation: vi.fn(),
  listConversations: vi.fn(async () => ({ conversations: [] })),
}));
vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => 'erase-1' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, on: (v: boolean) => void) => { on(seen.visible); return () => {}; } }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));

import { trackProductEvent } from '../lib/server-api';
import { setAssistantName, setChatSurface } from '../lib/assistant-config';
import { ChatEmbed } from './ChatEmbed';
import { ChatSection } from './ChatSection';

/** The words both surfaces draw from the table; the panel adds its column heading. */
const shared = (frame: HTMLElement) => ({
  label: frame.getAttribute('aria-label'),
  title: document.querySelector('.chat-header-title-block h3')?.textContent,
  subtitle: document.querySelector('.chat-header-sub')?.textContent,
  empty: document.querySelector('.chat-empty')?.textContent,
});
const panelWords = () => ({ heading: document.querySelector('.hr-col-title')?.textContent, ...shared(screen.getByRole('region')) });

beforeEach(() => { seen.visible = true; setAssistantName('Synthetic Shop'); vi.mocked(trackProductEvent).mockClear(); });
afterEach(() => { cleanup(); setChatSurface('doctor'); setAssistantName('Brad AI'); });

describe('US-15 AC77: the panel picks its words by the store, as the pop-up does', () => {
  it('a brand store: the brand words, with the store\'s assistant name', () => {
    setChatSurface('brand');
    render(<ChatEmbed isLoggedIn />);
    expect(panelWords()).toEqual({
      heading: 'Ask about our products',
      label: 'Synthetic Shop chat',
      title: 'Ask Synthetic Shop',
      subtitle: 'Products, ingredients, and the research behind them',
      empty: "Ask what's in a product, how to take it, or what the evidence says about an ingredient. For orders and subscriptions, sign in to your account.",
    });
  });

  it('a doctor store: the doctor words, as before', () => {
    render(<ChatEmbed isLoggedIn />);
    expect(panelWords()).toEqual({
      heading: 'Ask about your plan',
      label: 'Health by Dr Brad Chat',
      title: 'Discuss your health',
      subtitle: 'Answers cite your plan & the guidelines above',
      empty: 'Ask about your personalized suggestions based on your health data, clinical research, and the preventative care algorithm.',
    });
  });

  it.each(['doctor', 'brand'] as const)('%s: the panel and the pop-up carry the same label, title, subtitle and empty line', (surface) => {
    setChatSurface(surface);
    render(<ChatEmbed isLoggedIn />);
    const panel = shared(screen.getByRole('region'));
    cleanup();
    render(<ChatSection isLoggedIn startExpanded />);
    expect(shared(screen.getByRole('dialog'))).toEqual(panel);
  });
});

describe('US-15 AC77: a panel shown is counted under its own name', () => {
  it('sends chat_panel_shown, name only, when the panel comes into view', () => {
    render(<ChatEmbed isLoggedIn />);
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual([['chat_panel_shown']]);
  });

  it('sends nothing while the panel is out of view', () => {
    seen.visible = false;
    render(<ChatEmbed isLoggedIn />);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('the pop-up still sends chat_opened, never chat_panel_shown', () => {
    render(<ChatSection isLoggedIn startExpanded />);
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual([['chat_opened']]);
  });
});
