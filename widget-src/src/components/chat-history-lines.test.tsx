// @vitest-environment jsdom
/**
 * US-15 AC75: what the chat panel shows when its history file fails it.
 * - History after a failed list read says "Chat history unavailable", never the old titles or "No conversations yet".
 * - A reply the history file did not take says so by the reply.
 * - A reply with edits that landed after the person left its thread is stored marked, and its reopened thread says
 *   "Not saved" by it.
 * Synthetic chat; the transports are mocked at chat-api.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import type { ChatConversation, ChatMessage, ChatSent, ReplyMark, SendMessageResult } from '../lib/chat-api';

const sends = vi.hoisted(() => [] as Array<{ resolve: (r: unknown) => void; mark: (r: unknown) => unknown }>);
vi.mock('../lib/chat-sync', () => ({
  generateInstanceId: () => 'tab', postInputSync: vi.fn(), postSync: vi.fn(), subscribeSync: () => () => {},
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  sendMessage: vi.fn((...args: unknown[]) => new Promise((resolve) => { sends.push({ resolve, mark: args[6] as (r: unknown) => unknown }); })),
  listConversations: vi.fn(), loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../lib/roadmap-data', () => ({ getShownErase: () => 'erase-1' }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, on: (v: boolean) => void) => { on(true); return () => {}; } }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));

import { listConversations, loadConversation } from '../lib/chat-api';
import { ChatEmbed } from './ChatEmbed';
import { HISTORY_UNAVAILABLE } from './ChatThreadList';
import { REPLY_LEFT_NOT_SAVED, REPLY_NOT_SAVED } from './ChatMessageBubble';

const conversations: ChatConversation[] = [{ id: 'A', title: 'Thread A', updatedAt: 'x', createdAt: 'x' }];
const turn = (id: string, role: 'user' | 'assistant', content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: 'x', ...extra });
const EDITS = [{ kind: 'field', field: 'weightKg', value: '80', unit: 'kg', date: '2026-11-26' }] as SendMessageResult['proposedEdits'];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const historyText = () => document.querySelector('.chat-embed-thread-list')!.textContent;

async function ask(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
}
/** The last send lands with `result`; `saved` is its history save's outcome. */
async function land(result: SendMessageResult, saved?: Promise<'saved' | 'unsaved' | 'skipped'>) {
  const sent: ChatSent = { result, error: null, ...(saved ? { saved } : {}) };
  await act(async () => { sends.at(-1)!.resolve(sent); });
  await settle();
}

beforeEach(() => {
  sends.length = 0;
  vi.mocked(listConversations).mockReset().mockResolvedValue({ conversations } as never);
  vi.mocked(loadConversation).mockReset();
});
afterEach(cleanup);

describe('US-15 AC75: History after a failed list read', () => {
  it('says exactly "Chat history unavailable", not "No conversations yet"', async () => {
    vi.mocked(listConversations).mockResolvedValueOnce(null as never);
    render(<ChatEmbed isLoggedIn />);
    await settle();
    expect(historyText()).toBe(`Delete conversation+ New Chat${HISTORY_UNAVAILABLE}`);
    expect(HISTORY_UNAVAILABLE).toBe('Chat history unavailable');
  });

  it('says it instead of the titles it holds, a thread this page started included', async () => {
    vi.mocked(listConversations).mockResolvedValueOnce(null as never);
    render(<ChatEmbed isLoggedIn />);
    await settle();
    await ask('A question');
    await land({ conversationId: 'N', messageId: 'r1', content: 'An answer' });
    expect(historyText()).not.toContain('A question');
    expect(historyText()).toContain(HISTORY_UNAVAILABLE);
  });

  it('control: a list that reads shows its titles and no such line', async () => {
    render(<ChatEmbed isLoggedIn />);
    await settle();
    expect(historyText()).toContain('Thread A');
    expect(historyText()).not.toContain(HISTORY_UNAVAILABLE);
  });
});

describe('US-15 AC75: a reply the history file did not take', () => {
  it('shows "This reply was not saved to your chat history." by that reply only', async () => {
    render(<ChatEmbed isLoggedIn />);
    await settle();
    await ask('First');
    await land({ conversationId: 'N', messageId: 'r1', content: 'Saved answer' }, Promise.resolve('saved'));
    await ask('Second');
    await land({ conversationId: 'N', messageId: 'r2', content: 'Lost answer' }, Promise.resolve('unsaved'));
    const lines = [...document.querySelectorAll('.chat-message--assistant')].map((b) => b.textContent);
    expect(REPLY_NOT_SAVED).toBe('This reply was not saved to your chat history.');
    expect(lines[0]).not.toContain(REPLY_NOT_SAVED);
    expect(lines[1]).toContain(`Lost answer${REPLY_NOT_SAVED}`);
  });

  it('says nothing for a save that was skipped (an erase began, or there is no history file)', async () => {
    render(<ChatEmbed isLoggedIn />);
    await settle();
    await ask('First');
    await land({ conversationId: 'N', messageId: 'r1', content: 'Answer' }, Promise.resolve('skipped'));
    expect(document.body.textContent).not.toContain(REPLY_NOT_SAVED);
  });
});

describe('US-15 AC75: a reply with edits that landed after its thread was left', () => {
  async function askThenLeave() {
    vi.mocked(loadConversation).mockResolvedValue([turn('a1', 'user', 'old q'), turn('a2', 'assistant', 'old a')]);
    render(<ChatEmbed isLoggedIn />);
    await settle();
    await ask('My weight is 80 kg');
    fireEvent.click(screen.getByText('Thread A')); // the person opens another conversation before the reply
    await settle();
  }

  it('the transport is told to store it marked "left"', async () => {
    await askThenLeave();
    const result: SendMessageResult = { conversationId: 'N', messageId: 'r1', content: 'Pre-filled.', proposedEdits: EDITS };
    expect((sends[0].mark as ReplyMark)(result)).toBe('left');
    expect((sends[0].mark as ReplyMark)({ ...result, proposedEdits: undefined })).toBeUndefined(); // no edits: nothing lost
  });

  it('control: a reply landing in the thread that asked is not marked', async () => {
    render(<ChatEmbed isLoggedIn />);
    await settle();
    await ask('My weight is 80 kg');
    expect((sends[0].mark as ReplyMark)({ conversationId: 'N', messageId: 'r1', content: 'x', proposedEdits: EDITS })).toBeUndefined();
  });

  it('its reopened thread shows "Not saved" by the stored reply', async () => {
    vi.mocked(loadConversation).mockResolvedValue([
      turn('u1', 'user', 'My weight is 80 kg'), turn('a1', 'assistant', 'Pre-filled.', { notSaved: 'left' }),
    ]);
    render(<ChatEmbed isLoggedIn />);
    await settle();
    fireEvent.click(screen.getByText('Thread A'));
    await settle();
    const reply = [...document.querySelectorAll('.chat-message--assistant')].map((b) => b.textContent);
    expect(reply).toEqual([expect.stringContaining(`Pre-filled.${REPLY_LEFT_NOT_SAVED}`)]);
    expect(document.body.textContent).not.toContain(REPLY_NOT_SAVED);
  });
});
