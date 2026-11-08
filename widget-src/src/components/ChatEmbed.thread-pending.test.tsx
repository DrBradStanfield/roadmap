// @vitest-environment jsdom
/**
 * US-15 AC7a: a reply streams under the thread it was sent from. Send in A,
 * open B, and a delta for A's reply leaves B showing only the dots; back in A
 * the stream is there. Rendered through the real useChatState and ChatEmbed
 * (ChatSection draws the same state.pending/state.isLocalSender).
 */
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import type { ChatDelta, ChatMessage } from '../lib/chat-api';

const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });
const threads = vi.hoisted(() => ({} as Record<string, ChatMessage[]>));
const send = vi.hoisted(() => ({ onDelta: undefined as undefined | ((d: ChatDelta) => void) }));

vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  listConversations: vi.fn(async () => ({ conversations: [
    { id: 'A', title: 'Thread A', updatedAt: 'x', createdAt: 'x' },
    { id: 'B', title: 'Thread B', updatedAt: 'x', createdAt: 'x' },
  ] })),
  loadConversation: vi.fn(async (id: string) => threads[id]),
  sendMessage: vi.fn((_m: string, _c: unknown, _g: unknown, _h: unknown, onDelta: (d: ChatDelta) => void) => {
    send.onDelta = onDelta;
    return new Promise(() => {});
  }),
  deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test',
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, onChange: (v: boolean) => void) => { onChange(true); return () => {}; } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));

import { ChatEmbed } from './ChatEmbed';

threads.A = [turn('a1', 'user', 'A question'), turn('a2', 'assistant', 'A answer')];
threads.B = [turn('b1', 'user', 'B question'), turn('b2', 'assistant', 'B answer')];
const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

describe('US-15 AC7a — the streaming reply stays under its own thread (ChatEmbed)', () => {
  it('send in A, open B, a delta arrives: A\'s text is not under B; back in A it is', async () => {
    const { container } = render(<ChatEmbed isLoggedIn={false} />);
    await screen.findByText('A answer');
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'A follow-up' } });
    fireEvent.click(screen.getByLabelText('Send'));
    const openThread = async (title: string) => {
      fireEvent.click(screen.getByLabelText('Show conversations'));
      await act(async () => { fireEvent.click(screen.getByText(title)); });
    };
    await openThread('Thread B');
    await screen.findByText('B answer');
    await act(async () => {
      send.onDelta!({ type: 'thinking', text: 'A thinking' });
      send.onDelta!({ type: 'text', text: 'A streaming' });
      await nextFrame();
    });
    const messages = container.querySelector('.chat-embed-messages')!;
    expect(messages.textContent).not.toContain('A streaming');
    expect(messages.textContent).not.toContain('A thinking');
    expect(messages.querySelector('.chat-thinking-panel')).toBeNull();
    expect(messages.querySelector('.chat-thinking-dots')).not.toBeNull();
    await openThread('Thread A');
    await screen.findByText('A streaming');
    expect(container.querySelector('.chat-embed-messages')!.textContent).toContain('A thinking');
  });
});
