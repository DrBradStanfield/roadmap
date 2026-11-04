// @vitest-environment jsdom
/**
 * US-09 AC16a: a browser that blocks site storage still gets the chat.
 * Firefox's BroadcastChannel constructor throws a SecurityError when the
 * site's storage access is denied (dom/broadcastchannel/BroadcastChannel.cpp).
 * The chat's cross-tab sync created its channel as the chat mounted, so the
 * throw reached the error boundary and the tool showed "Something went wrong".
 * Synthetic constructors only; no real Firefox run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./chat-api', () => ({
  getChatGate: () => null,
  sendMessage: vi.fn(async () => ({ result: { conversationId: 'c1', messageId: null, content: 'Synthetic answer.' }, error: null })),
  listConversations: vi.fn(async () => ({ conversations: [] })),
  loadConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('./server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./observe-visibility', () => ({ observeVisibility: () => () => {} }));
vi.mock('../components/FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('../components/ChatKeyGate', () => ({ ChatKeyGate: () => null }));

/** The constructor as Firefox runs it with the site's storage blocked. */
class BlockedChannel {
  constructor() { throw new DOMException('The operation is insecure.', 'SecurityError'); }
}

/** A working channel that records what this page posts. */
const posted: unknown[] = [];
let opened = 0;
class RecordingChannel {
  listeners = new Set<(e: { data: unknown }) => void>();
  constructor() { opened += 1; }
  postMessage(msg: unknown) { posted.push(msg); }
  addEventListener(_type: string, fn: (e: { data: unknown }) => void) { this.listeners.add(fn); }
  removeEventListener(_type: string, fn: (e: { data: unknown }) => void) { this.listeners.delete(fn); }
  isClosed = false;
  close() { this.isClosed = true; }
}

/** chat-sync keeps one channel per page, so each case loads it fresh. */
async function freshModules() {
  vi.resetModules();
  const sync = await import('./chat-sync');
  const { ChatEmbed } = await import('../components/ChatEmbed');
  const { ErrorBoundary } = await import('../components/ErrorBoundary');
  const { sendMessage } = await import('./chat-api');
  return { sync, ChatEmbed, ErrorBoundary, sendMessage };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); posted.length = 0; opened = 0; });

describe('US-09 AC16a: the chat runs without cross-tab sync where the browser refuses a BroadcastChannel', () => {
  it('subscribing and posting do not throw', async () => {
    vi.stubGlobal('BroadcastChannel', BlockedChannel);
    const { sync } = await freshModules();
    let unsubscribe: (() => void) | undefined;
    expect(() => { unsubscribe = sync.subscribeSync(() => {}); }).not.toThrow();
    expect(() => unsubscribe!()).not.toThrow();
    expect(() => sync.postSync({ instanceId: 'a', type: 'thread-new', payload: {}, ts: 0 })).not.toThrow();
  });

  it('the chat opens and answers instead of the error screen', async () => {
    vi.stubGlobal('BroadcastChannel', BlockedChannel);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ChatEmbed, ErrorBoundary, sendMessage } = await freshModules();
    render(<ErrorBoundary><ChatEmbed isLoggedIn /></ErrorBoundary>);
    expect(screen.queryByText('Something went wrong')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'What is my LDL target?' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(await screen.findByText('Synthetic answer.')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('control: where the browser allows it, the chat still posts its state to other tabs', async () => {
    vi.stubGlobal('BroadcastChannel', RecordingChannel);
    const { sync } = await freshModules();
    sync.postSync({ instanceId: 'a', type: 'thread-new', payload: {}, ts: 0 });
    expect(posted).toEqual([{ instanceId: 'a', type: 'thread-new', payload: {}, ts: 0 }]);
  });

  it('control: a working channel delivers to a subscriber until it unsubscribes, and closes on page unload', async () => {
    let channel: RecordingChannel | undefined;
    vi.stubGlobal('BroadcastChannel', class extends RecordingChannel { constructor() { super(); channel = this; } });
    const { sync } = await freshModules();
    const got: unknown[] = [];
    const unsubscribe = sync.subscribeSync((msg) => got.push(msg));
    channel!.listeners.forEach((fn) => fn({ data: 'from another tab' }));
    unsubscribe();
    channel!.listeners.forEach((fn) => fn({ data: 'after unsubscribe' }));
    expect(got).toEqual(['from another tab']);
    window.dispatchEvent(new Event('beforeunload'));
    expect(channel!.isClosed).toBe(true);
    const before = opened;
    sync.postSync({ instanceId: 'a', type: 'thread-new', payload: {}, ts: 0 });
    expect(opened).toBe(before + 1);
  });

  it('control: a browser with no BroadcastChannel at all runs without sync, as before', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { sync } = await freshModules();
    expect(() => sync.subscribeSync(() => {})()).not.toThrow();
    expect(() => sync.postSync({ instanceId: 'a', type: 'thread-new', payload: {}, ts: 0 })).not.toThrow();
  });
});
