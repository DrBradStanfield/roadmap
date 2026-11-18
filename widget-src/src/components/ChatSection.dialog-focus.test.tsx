// @vitest-environment jsdom
/**
 * US-15 AC12a: opening the pop-up chat moves the focus to its title, Escape inside it closes it, and Close or Escape gives the focus
 * to the "Open chat" button that comes back. The real useChatState runs; chat-api, chat-sync, server-api and FeedbackForm are stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/chat-api', () => ({ getChatGate: () => null, listConversations: vi.fn(async () => ({ conversations: [] })), loadConversation: vi.fn(async () => []),
  sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn() }));
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
const button = <button type="button" className="chat-fab">Open chat</button>;
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
  it('opening it moves the focus to its title; Escape there closes it and gives the focus to the Open chat button; opened again, Close does too', async () => {
    const dialog = await openFromButton();
    expect(document.activeElement).toBe(title());
    expect(dialog.contains(title())).toBe(true);
    expect(title().tabIndex).toBe(-1);
    await act(async () => { fireEvent.keyDown(title(), { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fab()));
    await act(async () => { fireEvent.click(fab()); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close chat' })); });
    await waitFor(() => expect(document.activeElement).toBe(fab()));
  });

  it('another key, or an Escape flagged isComposing or with key code 229 (AC26a), in the message box does not close it; a plain Escape there does', async () => {
    await openFromButton();
    for (const key of [{ key: 'a' }, { key: 'Escape', isComposing: true }, { key: 'Escape', keyCode: 229 }]) {
      await act(async () => { fireEvent.keyDown(messageBox(), key); });
      expect(screen.queryByRole('dialog'), JSON.stringify(key)).not.toBeNull();
    }
    await act(async () => { fireEvent.keyDown(messageBox(), { key: 'Escape', keyCode: 27 }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an inline panel, drawn beside an Open chat button, takes no focus and does not close on Escape', async () => {
    const onClose = vi.fn();
    const { rerender } = render(button);
    fab().focus();
    await act(async () => { rerender(<>{button}<ChatSection isLoggedIn={false} startExpanded inline onClose={onClose} /></>); });
    expect(document.activeElement).toBe(fab());
    await act(async () => { fireEvent.keyDown(messageBox(), { key: 'Escape' }); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('kept on the page beside an Open chat button, closed and opened again from its collapsed row, it takes the focus again', async () => {
    const { rerender } = render(button);
    rerender(<>{button}<ChatSection isLoggedIn={false} startExpanded /></>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close chat' })); });
    await waitFor(() => expect(document.activeElement).toBe(fab()));
    await act(async () => { fireEvent.click(document.querySelector('.chat-collapsed')!); });
    expect(document.activeElement).toBe(title());
  });

  it('drawn with no Open chat button on the page (the page brought it back), it takes no focus, and Close moves none', async () => {
    render(<ChatSection isLoggedIn={false} startExpanded />);
    expect(document.activeElement).toBe(document.body);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close chat' })); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); }); // the frame the focus would go back on
    expect(document.activeElement).toBe(document.body);
  });

  it('a chat title drawn without a ref (the chat beside the plan) is not made focusable', () => {
    expect(render(<ChatHeaderTitle subtitle="Synthetic subtitle" />).container.querySelector('h3')!.hasAttribute('tabindex')).toBe(false);
  });
});
