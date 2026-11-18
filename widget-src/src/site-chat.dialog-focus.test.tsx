// @vitest-environment jsdom
/**
 * US-15 AC12a on the store-wide chat bubble, through the real `site-chat.tsx`
 * entry, ChatSection and useChatState: "Open chat" moves the focus to the
 * dialog's title, Escape closes the dialog, and Escape or Close gives the focus
 * to the "Open chat" button that comes back. Synthetic: nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, waitFor } from '@testing-library/react';

vi.mock('./lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('./lib/chat-api', () => ({
  getChatGate: () => null, listConversations: vi.fn(async () => ({ conversations: [] })), loadConversation: vi.fn(async () => []),
  sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn(),
}));
vi.mock('./lib/chat-sync', () => ({ postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));
vi.mock('./lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./components/FeedbackForm', () => ({ FeedbackForm: () => null }));

const fab = () => document.querySelector<HTMLButtonElement>('button.chat-fab');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function openBubble() {
  const root = document.createElement('div');
  root.id = 'health-chat-root';
  root.style.display = 'none';
  document.body.appendChild(root);
  await act(async () => { await import('./site-chat'); });
  fab()!.focus();
  await act(async () => { fireEvent.click(fab()!); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetModules();
});
afterEach(() => { document.body.replaceChildren(); });

describe('US-15 AC12a: the store-wide chat bubble', () => {
  it('Open chat moves the focus to the title inside the dialog', async () => {
    await openBubble();
    expect(document.activeElement?.tagName).toBe('H3');
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it('Escape closes the dialog and gives the focus to the Open chat button; opened again, Close does too', async () => {
    await openBubble();
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fab()));
    await act(async () => { fireEvent.click(fab()!); });
    await act(async () => { fireEvent.click(dialog()!.querySelector('button[aria-label="Close chat"]')!); });
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fab()));
  });
});
