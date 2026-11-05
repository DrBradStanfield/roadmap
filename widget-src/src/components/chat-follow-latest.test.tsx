// @vitest-environment jsdom
/**
 * US-15 AC55: both web chats (the panel beside the plan and the bubble) stay at
 * the latest message while the reader is there, whatever the size of what
 * arrives, and leave the view alone once the reader has scrolled up. Before,
 * the "was the reader at the bottom" check ran after the new message was in
 * the DOM, so a long question (a pasted report, US-15 AC26) looked like the
 * reader had scrolled away: the view stayed put and no jump-to-latest button
 * showed. jsdom has no layout, so each messages box gets a stand-in: 400px tall,
 * content 200px plus 1px per character of text, scrollTop clamped per element.
 * Synthetic text only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { act } from 'react';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import type { ChatMessage } from '../lib/chat-api';

const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });
const threads = vi.hoisted(() => ({} as Record<string, ChatMessage[]>));
const stream = vi.hoisted(() => ({ onDelta: undefined as undefined | ((d: unknown) => void) }));
const sync = vi.hoisted(() => ({ handler: undefined as undefined | ((msg: unknown) => void) }));

vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  listConversations: vi.fn(async () => ({ conversations: [
    { id: 'A', title: 'Thread A', updatedAt: 'x', createdAt: 'x' },
    { id: 'B', title: 'Thread B', updatedAt: 'x', createdAt: 'x' },
  ] })),
  loadConversation: vi.fn(async (id: string) => threads[id]),
  sendMessage: vi.fn((_m: unknown, _c: unknown, _g: unknown, _h: unknown, onDelta: (d: unknown) => void) => {
    stream.onDelta = onDelta;
    return new Promise(() => {});
  }),
  deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({
  postSync: vi.fn(), postInputSync: vi.fn(), generateInstanceId: () => 'test',
  subscribeSync: (handler: (msg: unknown) => void) => { sync.handler = handler; return () => {}; },
}));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, onChange: (v: boolean) => void) => { onChange(true); return () => {}; } }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));

import { ChatEmbed } from './ChatEmbed';
import { ChatSection } from './ChatSection';

threads.A = Array.from({ length: 8 }, (_, i) => turn(`t${i}`, i % 2 ? 'assistant' : 'user', `Synthetic turn ${i} with a few words of text`));
threads.B = Array.from({ length: 6 }, (_, i) => turn(`b${i}`, i % 2 ? 'assistant' : 'user', 'Synthetic B turn '.repeat(30)));

const VIEW = 400;
const BOXES = ['chat-embed-messages', 'chat-messages'];
const isBox = (el: Element) => BOXES.some(c => el.classList.contains(c));
const scrollTops = new WeakMap<Element, number>();
const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) saved[key] = Object.getOwnPropertyDescriptor(Element.prototype, key);
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isBox(this) ? 200 + (this.textContent?.length ?? 0) : 0; } });
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isBox(this) ? VIEW : 0; } });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) { return scrollTops.get(this) ?? 0; },
    set(this: Element, v: number) { scrollTops.set(this, Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))); },
  });
});
afterAll(() => {
  for (const [key, d] of Object.entries(saved)) if (d) Object.defineProperty(Element.prototype, key, d);
});
afterEach(cleanup);

const distanceFromBottom = (el: Element) => el.scrollHeight - el.scrollTop - el.clientHeight;
const PASTED = 'Synthetic pasted report line with a value and a unit. '.repeat(12); // ~650 characters

const surfaces = [
  { name: 'the panel beside the plan (ChatEmbed)', box: '.chat-embed-messages', mount: () => render(<ChatEmbed isLoggedIn={false} />) },
  { name: 'the bubble (ChatSection)', box: '.chat-messages', mount: () => render(<ChatSection isLoggedIn={false} startExpanded />) },
];

describe.each(surfaces)('US-15 AC55: $name follows the latest message while the reader is there', ({ box: selector, mount }) => {
  async function open() {
    const { container } = mount();
    await screen.findByText(/Synthetic turn 7/);
    return { container, box: container.querySelector(selector)! };
  }
  async function send(container: HTMLElement, question: string) {
    await act(async () => {
      fireEvent.change(container.querySelector('textarea')!, { target: { value: question } });
      fireEvent.click(screen.getByLabelText('Send'));
    });
  }
  const scrollTo = (box: Element, top: number) => { box.scrollTop = top; fireEvent.scroll(box); };
  const jumpButton = (container: HTMLElement) => container.querySelector('.chat-scroll-btn');

  it('a short question sent from the bottom keeps the view at the bottom', async () => {
    const { container, box } = await open();
    scrollTo(box, box.scrollHeight);
    await send(container, 'A short synthetic question?');
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('a long question (a pasted report) sent from the bottom keeps the view at the bottom, with no jump button', async () => {
    const { container, box } = await open();
    scrollTo(box, box.scrollHeight);
    await send(container, PASTED);
    expect(distanceFromBottom(box)).toBe(0);
    fireEvent.scroll(box); // the browser's scroll event after the follow
    expect(jumpButton(container)).toBeNull();
  });

  it('a reader just inside the near-bottom band is still followed', async () => {
    const { container, box } = await open();
    scrollTo(box, box.scrollHeight - box.clientHeight - 99);
    await send(container, PASTED);
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('a reader who scrolled up is left where they are, and sees the jump button', async () => {
    const { container, box } = await open();
    scrollTo(box, 0);
    expect(jumpButton(container)).not.toBeNull();
    await send(container, 'A short synthetic question?');
    expect(box.scrollTop).toBe(0);
    fireEvent.click(jumpButton(container)!);
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('a reader 100px or more above the bottom is not followed', async () => {
    const { container, box } = await open();
    scrollTo(box, box.scrollHeight - box.clientHeight - 100);
    const before = box.scrollTop;
    await send(container, 'A short synthetic question?');
    expect(box.scrollTop).toBe(before);
  });
});

const frame = () => new Promise(r => setTimeout(r, 30));
/** A reply streamed in small text deltas, each given time to render. */
async function streamReply(chunks: number) {
  for (let i = 0; i < chunks; i++) await act(async () => { stream.onDelta!({ type: 'text', text: 'x'.repeat(50) }); await frame(); });
}
async function sendShort(container: HTMLElement) {
  await act(async () => {
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'A short synthetic question?' } });
    fireEvent.click(screen.getByLabelText('Send'));
  });
}

describe('US-15 AC55: another conversation in the same list is read afresh', () => {
  async function openPanel() {
    const { container } = render(<ChatEmbed isLoggedIn={false} />);
    await screen.findByText(/Synthetic turn 7/);
    const box = container.querySelector('.chat-embed-messages')!;
    return { container, box };
  }
  const scrollTo = (box: Element, top: number) => { box.scrollTop = top; fireEvent.scroll(box); };

  it('the panel: a reader who scrolled up in one conversation, then starts a new chat, is followed through its streamed reply', async () => {
    const { container, box } = await openPanel();
    scrollTo(box, 0);
    await act(async () => { fireEvent.click(screen.getByText('+ New Chat')); });
    await sendShort(container);
    await streamReply(20);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 100);
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('the panel: a reader at the bottom of one conversation who opens a long one is not moved by the follow, as before', async () => {
    const { box } = await openPanel();
    scrollTo(box, box.scrollHeight);
    const before = box.scrollTop;
    await act(async () => { fireEvent.click(screen.getByText('Thread B')); await frame(); });
    await screen.findAllByText(/Synthetic B turn/);
    expect(box.scrollTop).toBe(before);
    expect(distanceFromBottom(box)).toBeGreaterThan(100);
  });

  it('the bubble: a reader who scrolled up, then starts a new chat from History, is followed through its streamed reply', async () => {
    const { container } = render(<ChatSection isLoggedIn={false} startExpanded />);
    await screen.findByText(/Synthetic turn 7/);
    scrollTo(container.querySelector('.chat-messages')!, 0);
    await act(async () => { fireEvent.click(screen.getByText('History')); });
    await act(async () => { fireEvent.click(screen.getByText('+ New Chat')); });
    if (screen.queryByText('Back')) await act(async () => { fireEvent.click(screen.getByText('Back')); });
    await sendShort(container);
    await streamReply(20);
    const box = container.querySelector('.chat-messages')!;
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 100);
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('the bubble: a reader at the bottom when another tab opens a long conversation is not moved by the follow, as before', async () => {
    const { container } = render(<ChatSection isLoggedIn={false} startExpanded />);
    await screen.findByText(/Synthetic turn 7/);
    const box = container.querySelector('.chat-messages')!;
    scrollTo(box, box.scrollHeight);
    const before = box.scrollTop;
    await act(async () => {
      sync.handler!({ instanceId: 'other-tab', type: 'state', ts: 1, payload: {
        conversations: [], activeConversationId: 'B', messages: threads.B, isLoading: false, error: null,
      } });
    });
    await screen.findAllByText(/Synthetic B turn/);
    expect(box.scrollTop).toBe(before);
    expect(distanceFromBottom(box)).toBeGreaterThan(100);
  });

  it('the panel: a pasted report as the first message of a new chat is followed, with no scroll ever made', async () => {
    const { container, box } = await openPanel();
    await act(async () => { fireEvent.click(screen.getByText('+ New Chat')); });
    await act(async () => {
      fireEvent.change(container.querySelector('textarea')!, { target: { value: PASTED } });
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 100);
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('the bubble: a pasted report as the first message of a new chat is followed, with no scroll ever made', async () => {
    const { container } = render(<ChatSection isLoggedIn={false} startExpanded />);
    await screen.findByText(/Synthetic turn 7/);
    await act(async () => { fireEvent.click(screen.getByText('History')); });
    await act(async () => { fireEvent.click(screen.getByText('+ New Chat')); });
    if (screen.queryByText('Back')) await act(async () => { fireEvent.click(screen.getByText('Back')); });
    await act(async () => {
      fireEvent.change(container.querySelector('textarea')!, { target: { value: PASTED } });
      fireEvent.click(screen.getByLabelText('Send'));
    });
    const box = container.querySelector('.chat-messages')!;
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight + 100);
    expect(distanceFromBottom(box)).toBe(0);
  });

  it('the panel: a reader following a streaming reply who opens a long conversation lands where it did before', async () => {
    const { container, box } = await openPanel();
    scrollTo(box, box.scrollHeight);
    await sendShort(container);
    await streamReply(6);
    expect(distanceFromBottom(box)).toBe(0);
    await act(async () => { fireEvent.click(screen.getAllByText('Thread B')[0]); await frame(); });
    await screen.findAllByText(/Synthetic B turn/);
    // Not carried to B's bottom by a reading made for A (the view keeps A's clamped offset, as before).
    expect(distanceFromBottom(box)).toBeGreaterThan(100);
  });
});
