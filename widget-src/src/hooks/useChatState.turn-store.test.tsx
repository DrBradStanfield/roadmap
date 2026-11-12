// @vitest-environment jsdom
/**
 * Chat-turn reducer, slice 2: the web chat's turn and shown chat on the store.
 * - US-15 AC7a (amended 2026-11-12): New chat just after a send shows no dots, and Send stays locked.
 * - N1: a thread read that rejects, throws, or never answers ends; Send never stays locked by it.
 * - N2: a failed read is never an empty thread: it says so, offers Try again, and no send goes out.
 * - N4: other tabs hear only a request in flight, never this tab's thread load.
 * - R5: an older bundle's wait still ends at this tab's own end, now the store's own-ended effect.
 * - PR 1359 review: R1 (a post whose thread is not read), R2 (a read left stops), R3 (words beside a locked Send),
 *   R4 (an older bundle's isLoading).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, renderHook, cleanup, fireEvent, screen } from '@testing-library/react';
import type { ChatMessage } from '../lib/chat-api';
import type { SyncMessage } from '../lib/chat-sync';

/** One BroadcastChannel for every hook in a test: each tab hears the others. */
const channel = vi.hoisted(() => ({ handlers: new Map<string, (m: SyncMessage) => void>(), next: 0 }));
const send = vi.hoisted(() => ({ resolve: undefined as undefined | ((r: unknown) => void) }));
vi.mock('../lib/chat-sync', () => ({
  generateInstanceId: () => `tab-${++channel.next}`,
  postInputSync: vi.fn(),
  postSync: vi.fn((m: SyncMessage) => { channel.handlers.forEach((h) => h(m)); }),
  subscribeSync: (h: (m: SyncMessage) => void) => {
    const key = `h${channel.handlers.size}-${Math.random()}`;
    channel.handlers.set(key, h);
    return () => { channel.handlers.delete(key); };
  },
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null,
  sendMessage: vi.fn(() => new Promise((resolve) => { send.resolve = resolve; })),
  listConversations: vi.fn(async () => ({ conversations: [{ id: 'A', title: 'Thread A' }, { id: 'B', title: 'Thread B' }] })),
  loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/observe-visibility', () => ({ observeVisibility: (_el: Element, on: (v: boolean) => void) => { on(true); return () => {}; } }));
vi.mock('../components/ChatKeyGate', () => ({ ChatKeyGate: () => null }));

import { loadConversation, sendMessage } from '../lib/chat-api';
import { postSync } from '../lib/chat-sync';
import { useChatState } from './useChatState';
import { ORPHANED_LINE, WAITING_LINE } from '../components/ChatLoadLine';
import { LOAD_TIMEOUT_MS } from './chatReads';
import { tellChats } from './chatStore';
import { ChatEmbed } from '../components/ChatEmbed';

type Hook = { result: { current: ReturnType<typeof useChatState> } };
const turn = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({ id, role, content, createdAt: 'x' });
const threadA = [turn('a1', 'user', 'A question'), turn('a2', 'assistant', 'A answer')];
const conversations = [{ id: 'A', title: 'Thread A' }, { id: 'B', title: 'Thread B' }];
const atNew = { conversations, messages: [], activeConversationId: null };

async function sendHere(hook: Hook, text = 'And LDL?') {
  act(() => hook.result.current.actions.handleInputChange(text));
  await act(async () => { void hook.result.current.actions.handleSend(); });
}
const replyLands = (conversationId = 'N') => act(async () => { send.resolve!({ result: { conversationId, messageId: 'm', content: 'LDL too.' }, error: null }); });
const never = () => new Promise<never>(() => {});
const threadB = [turn('b1', 'user', 'B question'), turn('b2', 'assistant', 'B answer')];
const atA = { conversations, messages: threadA, activeConversationId: 'A' };
const statePosts = () => vi.mocked(postSync).mock.calls.map(([m]) => m).filter((m) => m.type === 'state');
const oldBundleBusy = () => act(() => channel.handlers.forEach((h) => h({
  instanceId: 'old-bundle-tab', type: 'state', ts: 0,
  payload: { conversations: [], activeConversationId: null, messages: [], isLoading: true, error: null },
})));

beforeEach(() => { vi.mocked(sendMessage).mockClear(); vi.mocked(postSync).mockClear(); vi.mocked(loadConversation).mockReset(); channel.handlers.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('US-15 AC7a (amended 2026-11-12): New chat while this tab\'s reply is in flight', () => {
  it('New chat 0.6 s after a send shows no dots in the new chat, and Send stays locked until the reply ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(<ChatEmbed isLoggedIn />);
    await screen.findByText('Thread A');
    const box = view.container.querySelector('textarea')!;
    fireEvent.change(box, { target: { value: 'What about ApoB?' } });
    await act(async () => { fireEvent.click(screen.getByLabelText('Send')); });
    expect(view.container.querySelector('.chat-loading')).not.toBeNull(); // the chat that asked shows its pending reply
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.click(screen.getByLabelText('Show conversations'));
    await act(async () => { fireEvent.click(view.container.querySelector('.chat-new-btn')!); });
    const messages = view.container.querySelector('.chat-embed-messages')!;
    expect(messages.querySelector('.chat-loading')).toBeNull(); // no dots, no pending reply
    expect(messages.textContent).not.toContain('What about ApoB?');
    // R3: the locked Send has words beside it, and the empty-chat prompt gives way to them.
    expect(messages.textContent).toContain(WAITING_LINE);
    expect(messages.querySelector('.chat-empty')).toBeNull();
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    expect(box.disabled).toBe(true);
    await replyLands();
    expect(box.disabled).toBe(false);
    expect(view.container.querySelector('.chat-embed-messages')!.textContent).not.toContain('LDL too.');
    expect(view.container.querySelector('.chat-embed-messages')!.textContent).not.toContain(WAITING_LINE);
    expect(view.container.querySelector('.chat-empty')).not.toBeNull();
  });
});

describe('N1, N2: a thread read that fails or hangs', () => {
  it('a rejected read: "Couldn\'t open this conversation." with Try again, Send locked, and no send goes out', async () => {
    vi.mocked(loadConversation).mockRejectedValueOnce(new Error('network down'));
    const view = render(<ChatEmbed isLoggedIn />);
    await screen.findByText('Thread A');
    fireEvent.click(screen.getByLabelText('Show conversations'));
    await act(async () => { fireEvent.click(screen.getByText('Thread A')); });
    expect(await screen.findByText('Couldn\'t open this conversation.')).toBeTruthy();
    expect(view.container.querySelector('.chat-empty')).toBeNull(); // never shown as an empty thread
    fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'B follow-up' } });
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(view.container.querySelector('textarea')!, { key: 'Enter' });
    expect(sendMessage).not.toHaveBeenCalled();
    // Try again reads the same thread once more.
    vi.mocked(loadConversation).mockResolvedValueOnce(threadA);
    await act(async () => { fireEvent.click(screen.getByText('Try again')); });
    expect(await screen.findByText('A answer')).toBeTruthy();
    expect(vi.mocked(loadConversation).mock.calls.map(([id]) => id)).toEqual(['A', 'A']);
    expect(screen.queryByText('Couldn\'t open this conversation.')).toBeNull();
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a read that throws synchronously ends as failed', async () => {
    vi.mocked(loadConversation).mockImplementationOnce(() => { throw new Error('store unreadable'); });
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await act(async () => { await hook.result.current.actions.selectConversation('A'); });
    expect(hook.result.current.state).toMatchObject({ load: 'failed', isLoading: true, activeConversationId: 'A', messages: [] });
  });

  it('a read that never answers: "Loading conversation…" while it runs, failed at 20 s, its timer cleared', async () => {
    vi.useFakeTimers();
    vi.mocked(loadConversation).mockImplementationOnce(never);
    render(<ChatEmbed isLoggedIn />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByLabelText('Show conversations'));
    await act(async () => { fireEvent.click(screen.getByText('Thread A')); });
    expect(screen.getByText('Loading conversation…')).toBeTruthy();
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1); });
    expect(screen.queryByText('Couldn\'t open this conversation.')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Couldn\'t open this conversation.')).toBeTruthy();
  });

  it('a timed-out read for a thread already left changes nothing: its landing names the load it began under', async () => {
    vi.useFakeTimers();
    vi.mocked(loadConversation).mockImplementationOnce(never).mockResolvedValueOnce(threadA);
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    act(() => { void hook.result.current.actions.selectConversation('B'); });
    await act(async () => { await hook.result.current.actions.selectConversation('A'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); });
    expect(hook.result.current.state).toMatchObject({ load: 'none', activeConversationId: 'A', isLoading: false });
    expect(hook.result.current.state.messages).toEqual(threadA);
  });

  it('R2: New chat during a hung read stops its timer and aborts its fetch at once', async () => {
    vi.useFakeTimers();
    vi.mocked(loadConversation).mockImplementationOnce(never);
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    act(() => { void hook.result.current.actions.selectConversation('A'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(1);
    const signal = vi.mocked(loadConversation).mock.calls[0][1]!;
    act(() => hook.result.current.actions.startNewChat());
    expect(vi.getTimerCount()).toBe(0);
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.state).toMatchObject({ load: 'none', activeConversationId: null, isLoading: false });
  });

  it('unmounting while a read is out clears its timer', async () => {
    vi.useFakeTimers();
    vi.mocked(loadConversation).mockImplementationOnce(never);
    const hook = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    act(() => { void hook.result.current.actions.selectConversation('A'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('N4: other tabs hear only a request in flight', () => {
  it('tab A\'s thread load hangs after its reply ends: tab B\'s Send stays unlocked', async () => {
    // A's read hangs; B reads the thread A shows itself (R1), and that read lands.
    vi.mocked(loadConversation).mockImplementationOnce(never).mockResolvedValue(threadB);
    const tabA = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    const tabB = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await sendHere(tabA);
    expect(tabB.result.current.state.isLoading).toBe(true); // A's request is open
    act(() => { void tabA.result.current.actions.selectConversation('B'); });
    await replyLands();
    // A's end, posted while its load was out: not sending, not loaded. (B's read then lands and A mirrors it.)
    expect(statePosts().map((m) => m.payload)).toContainEqual(expect.objectContaining({ activeConversationId: 'B', sending: false, isLoading: false, loaded: false }));
    expect(tabB.result.current.state).toMatchObject({ isLoading: false, activeConversationId: 'B', messages: threadB });
  });
});

describe('R4: an older bundle reads only isLoading', () => {
  it('a post with a load in flight and no turn says isLoading false when no other tab is busy', async () => {
    vi.mocked(loadConversation).mockImplementation(never);
    const tabA = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    await sendHere(tabA);
    act(() => { void tabA.result.current.actions.selectConversation('B'); });
    vi.mocked(postSync).mockClear();
    await replyLands();
    expect(tabA.result.current.state).toMatchObject({ load: 'loading', isLoading: true });
    expect(statePosts().at(-1)!.payload).toMatchObject({ isLoading: false, sending: false });
  });

  it('a post with no turn keeps an older bundle\'s wait in the other tabs: isLoading says another tab is busy', async () => {
    vi.mocked(loadConversation).mockResolvedValue(threadA);
    const tabX = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    const tabY = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atNew }));
    oldBundleBusy();
    expect(tabY.result.current.state.isLoading).toBe(true);
    vi.mocked(postSync).mockClear();
    await act(async () => { await tabX.result.current.actions.selectConversation('A'); }); // its landing posts
    expect(statePosts().at(-1)!.payload).toMatchObject({ sending: false, isLoading: true, loaded: true });
    expect(tabY.result.current.state.isLoading).toBe(true);
  });
});

describe('R1: a post from a tab whose thread is not read', () => {
  it('the other tab reads the thread itself, and sends with its turns, never with the empty ones posted', async () => {
    vi.mocked(loadConversation).mockImplementationOnce(never).mockResolvedValueOnce(threadB);
    const tabX = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atA }));
    const tabY = renderHook(() => useChatState({ isLoggedIn: false, prefetchedData: atA }));
    await sendHere(tabX);
    act(() => { void tabX.result.current.actions.selectConversation('B'); }); // X's read of B hangs
    await replyLands('A');
    await act(async () => {});
    expect(statePosts().map((m) => m.payload)).toContainEqual(expect.objectContaining({ activeConversationId: 'B', messages: [], loaded: false })); // X's
    expect(vi.mocked(loadConversation).mock.calls.map(([id]) => id)).toEqual(['B', 'B']);
    expect(tabY.result.current.state).toMatchObject({ activeConversationId: 'B', messages: threadB, load: 'none', isLoading: false });
    await sendHere(tabY, 'B follow-up');
    expect(vi.mocked(sendMessage).mock.calls[1][3]).toEqual(threadB);
  });
});

describe('R3: an erase empties the chat while its request is open', () => {
  it('says so beside the locked Send; the reply that lands is never shown and never posted to other tabs', async () => {
    const view = render(<ChatEmbed isLoggedIn />);
    const box = view.container.querySelector('textarea')!;
    fireEvent.change(box, { target: { value: 'What about ApoB?' } });
    await act(async () => { fireEvent.click(screen.getByLabelText('Send')); });
    act(() => tellChats({ type: 'erase-shown', erase: 'erase-r3', by: 'own' }));
    const messages = () => view.container.querySelector('.chat-embed-messages')!;
    expect(messages().textContent).toContain(ORPHANED_LINE);
    expect(messages().querySelector('.chat-empty')).toBeNull();
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(postSync).mockClear();
    await replyLands();
    expect(messages().textContent).not.toContain('LDL too.');
    expect(messages().textContent).not.toContain(ORPHANED_LINE);
    expect(messages().querySelector('.chat-empty')).not.toBeNull();
    expect(statePosts().length).toBeGreaterThan(0); // its end is posted, without the reply
    expect(JSON.stringify(vi.mocked(postSync).mock.calls)).not.toContain('LDL too.');
  });
});

describe('R5: an older bundle\'s wait ends at this tab\'s own end', () => {
  it('this tab\'s reply orphaned by an erase still frees an older bundle\'s mirroring tab as it ends', async () => {
    const hook = renderHook(() => useChatState({ isLoggedIn: false }));
    await sendHere(hook);
    act(() => channel.handlers.forEach((h) => h({
      instanceId: 'old-bundle-tab', type: 'state', ts: 0,
      payload: { conversations: [], activeConversationId: null, messages: [], isLoading: true, error: null },
    })));
    act(() => tellChats({ type: 'erase-shown', erase: 'erase-after', by: 'own' }));
    expect(hook.result.current.state).toMatchObject({ isLoading: true, isLocalSender: false, messages: [], wait: 'orphaned' });
    await replyLands();
    expect(hook.result.current.state).toMatchObject({ isLoading: false, wait: null });
    expect(hook.result.current.state.messages).toEqual([]);
  });
});
