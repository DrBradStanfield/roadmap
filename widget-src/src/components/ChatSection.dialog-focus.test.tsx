// @vitest-environment jsdom
/**
 * US-15 AC12a: opening the pop-up chat moves the focus to its title, Escape inside
 * it closes it, and Close or Escape gives the focus to the "Open chat" button that
 * comes back. The real useChatState runs; chat-api, chat-sync, server-api and
 * FeedbackForm are stubbed. Synthetic: nothing is sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null, listConversations: vi.fn(async () => ({ conversations: [] })), loadConversation: vi.fn(async () => []),
  sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({ postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));

import { ChatSection } from './ChatSection';
import { ChatHeaderTitle } from './ChatHeaderTitle';

/** A page as both surfaces draw it: the button and the panel take each other's place. */
function Page() {
  const [open, setOpen] = useState(false);
  return open
    ? <ChatSection isLoggedIn={false} startExpanded onClose={() => setOpen(false)} />
    : <button type="button" className="chat-fab" onClick={() => setOpen(true)}>Open chat</button>;
}

const fab = () => screen.getByRole('button', { name: 'Open chat' });
const title = () => screen.getByRole('heading', { name: 'Discuss your health' });
const messageBox = () => screen.getByPlaceholderText('Ask a question');

async function openFromButton() {
  render(<Page />);
  fab().focus();
  await act(async () => { fireEvent.click(fab()); });
  return screen.getByRole('dialog', { name: 'Health by Dr Brad Chat' });
}

afterEach(cleanup);

describe('US-15 AC12a: the pop-up chat takes the focus, closes on Escape and gives the focus back', () => {
  it('opening it moves the focus to its title, not to the message box', async () => {
    const dialog = await openFromButton();
    expect(document.activeElement).toBe(title());
    expect(dialog.contains(title())).toBe(true);
    expect(title().tabIndex).toBe(-1);
    expect(messageBox()).not.toBe(document.activeElement);
  });

  it('Escape inside it closes it and gives the focus to the Open chat button', async () => {
    await openFromButton();
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fab()));
  });

  it('Close gives the focus to the Open chat button', async () => {
    await openFromButton();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close chat' })); });
    await waitFor(() => expect(document.activeElement).toBe(fab()));
  });

  it('another key, or an Escape that ends an IME composition, in the message box does not close it; a plain Escape there does', async () => {
    await openFromButton();
    await act(async () => { fireEvent.keyDown(messageBox(), { key: 'a' }); });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await act(async () => { fireEvent.keyDown(messageBox(), { key: 'Escape', isComposing: true }); });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    await act(async () => { fireEvent.keyDown(messageBox(), { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an inline panel takes no focus and does not close on Escape', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<button type="button">Elsewhere</button>);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => { rerender(<><button type="button">Elsewhere</button><ChatSection isLoggedIn={false} startExpanded inline onClose={onClose} /></>); });
    expect(document.activeElement).toBe(elsewhere);
    await act(async () => { fireEvent.keyDown(messageBox(), { key: 'Escape' }); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('with no Open chat button on the page, Close moves no focus; opening the collapsed row again focuses the title', async () => {
    render(<ChatSection isLoggedIn={false} startExpanded />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close chat' })); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); }); // the frame the focus would go back on
    expect(document.activeElement).toBe(document.body);
    await act(async () => { fireEvent.click(document.querySelector('.chat-collapsed')!); });
    expect(document.activeElement).toBe(title());
  });

  it('a chat title drawn without a ref (the chat beside the plan) is not made focusable', () => {
    render(<ChatHeaderTitle subtitle="Synthetic subtitle" />);
    expect(title().hasAttribute('tabindex')).toBe(false);
  });
});
