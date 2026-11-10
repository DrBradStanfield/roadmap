// @vitest-environment jsdom
/**
 * US-15 AC46: each thread's Delete control in the chat History list can be
 * found and used from the keyboard. It is named after its thread, a key press
 * on it is not taken over by the row (which opens the thread), and it shows
 * when it or its row has focus, and always on a screen with no hover.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ChatThreadList } from './ChatThreadList';
import { cascaded, focusOn } from '../testing/css-cascade';

const conversations = [
  { id: 'c1', title: 'Old thread', updatedAt: 'x', createdAt: 'x' },
  { id: 'c2', title: '', updatedAt: 'x', createdAt: 'x' },
];

function list() {
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  const view = render(
    <ChatThreadList conversations={conversations} activeConversationId={null} className="t" onSelect={onSelect} onNew={() => {}} onDelete={onDelete} />,
  );
  return { view, onSelect, onDelete };
}

afterEach(cleanup);

describe('US-15 AC46 — the Delete control in the chat History list', () => {
  it('US-15 AC46: each Delete control is named after its thread', () => {
    const { view } = list();
    expect(view.getByRole('button', { name: 'Delete conversation Old thread' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Delete conversation Untitled' })).toBeTruthy();
  });

  it.each(['Enter', ' '])('US-15 AC46: %j on the Delete control is left to the button, and does not open the thread', (key) => {
    const { view, onSelect } = list();
    const del = view.container.querySelector<HTMLButtonElement>('.chat-thread-delete')!;
    del.focus();
    // fireEvent returns false when a handler called preventDefault, which would
    // cancel the browser's click on the focused button.
    expect(fireEvent.keyDown(del, { key })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('US-15 AC46 control: %j on the row itself still opens the thread', (key) => {
    const { view, onSelect } = list();
    const row = view.getByRole('button', { name: /^Old thread/ });
    expect(fireEvent.keyDown(row, { key })).toBe(false);
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('US-15 AC46: styles.css shows the Delete control on focus, and always where there is no hover', () => {
    // jsdom applies no :focus-within or media queries, so this resolves the cascade from styles.css.
    const { view } = list();
    const del = view.getByRole('button', { name: 'Delete conversation Old thread' });
    expect(del.closest('.chat-thread-item')).not.toBeNull();
    const mouse = { width: 1280, hover: true };
    const row = del.closest('.chat-thread-item')!;
    expect(cascaded(del, 'opacity', mouse)).toBe('0'); // hidden until the row is hovered or focused
    expect(cascaded(del, 'opacity', { ...mouse, states: focusOn(row) })).toBe('1'); // the row has focus
    expect(cascaded(del, 'opacity', { ...mouse, states: focusOn(del) })).toBe('1'); // the control itself has focus
    expect(cascaded(del, 'opacity', { width: 1280, hover: false })).toBe('1'); // no hover: always shown
  });
});
