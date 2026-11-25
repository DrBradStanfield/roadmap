// @vitest-environment jsdom
/**
 * US-15 AC77: every chat entry reads the store's chat posture the same way.
 * The three Liquid blocks emit one `data-surface` line, from the store's fixed
 * metafield only (no person's data), and the chatbot embed's entry hands it to
 * the panel, so a brand store's embed reads the brand words and a doctor
 * store's the doctor words. The tool page's entry is checked in
 * standalone/chat-surface.test.tsx; the words per posture in
 * components/chat-panel-surface.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';

vi.mock('./lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('./lib/chat-api', () => ({
  getChatGate: () => null, sendMessage: vi.fn(), deleteConversation: vi.fn(), loadConversation: vi.fn(),
  listConversations: vi.fn(async () => ({ conversations: [] })),
}));
vi.mock('./lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));
vi.mock('./lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./lib/observe-visibility', () => ({ observeVisibility: () => () => {} }));

const block = (name: string) => readFileSync(resolve(__dirname, `../../extensions/health-tool-widget/blocks/${name}`), 'utf8');
const SURFACE_LINE = `data-surface="{{ shop.metafields.health_roadmap.chat_surface | default: 'doctor' | escape }}"`;

describe('US-15 AC77: the Liquid blocks carry the store\'s chat posture', () => {
  it.each(['chat-embed.liquid', 'app-block.liquid', 'chatbot-embed.liquid'])('%s emits the one data-surface line', (name) => {
    const liquid = block(name);
    expect(liquid).toContain(SURFACE_LINE);
    expect(liquid.match(/data-surface=/g)).toHaveLength(1);
  });
});

async function mountEmbed(surface: string) {
  vi.resetModules();
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.id = 'health-chatbot-embed-root';
  root.dataset.surface = surface;
  root.dataset.assistantName = 'Synthetic Shop';
  document.body.appendChild(root);
  await act(async () => { await import('./chatbot-embed'); });
  return {
    heading: root.querySelector('.hr-col-title')?.textContent,
    label: root.querySelector('[role="region"]')?.getAttribute('aria-label'),
    title: root.querySelector('.chat-header-title-block h3')?.textContent,
  };
}

beforeEach(() => { localStorage.clear(); });

describe('US-15 AC77: the chatbot embed reads its words by the store\'s posture', () => {
  it('a brand store: the brand words', async () => {
    expect(await mountEmbed('brand')).toEqual({ heading: 'Ask about our products', label: 'Synthetic Shop chat', title: 'Ask Synthetic Shop' });
  });
  it('a doctor store: the doctor words, as before', async () => {
    expect(await mountEmbed('doctor')).toEqual({ heading: 'Ask about your plan', label: 'Health by Dr Brad Chat', title: 'Discuss your health' });
  });
});
