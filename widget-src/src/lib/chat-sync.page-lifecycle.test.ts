// @vitest-environment jsdom
/**
 * US-15 AC17f: the chat keeps hearing other tabs after a leave that does not
 * happen, and hears them again after the back-forward cache shows the page
 * again. Before, the channel closed on `beforeunload` and the chat's one
 * subscription stayed on the closed channel, so this tab went deaf to other
 * tabs (AC17c, AC17d) until a reload, while it still sent to them.
 * Node's BroadcastChannel stands in for the browser's; synthetic messages only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const NAME = 'hr_chat_sync';
const fromOther = { instanceId: 'other-tab', type: 'thread-new', payload: {}, ts: 1 } as const;
const fromHere = { instanceId: 'this-tab', type: 'thread-new', payload: {}, ts: 2 } as const;
const settle = () => new Promise((r) => setTimeout(r, 50));
const opened: BroadcastChannel[] = [];

/** Another tab on the same channel, recording what it hears. */
function otherTab() {
  const ch = new BroadcastChannel(NAME);
  opened.push(ch);
  const heard: unknown[] = [];
  ch.onmessage = (e) => heard.push(e.data);
  return { post: () => ch.postMessage(fromOther), heard };
}

/** chat-sync keeps one channel per page, so each case loads it fresh. */
async function freshSync() {
  vi.resetModules();
  return import('./chat-sync');
}

const pageTransition = (type: 'pagehide' | 'pageshow', persisted: boolean) =>
  window.dispatchEvent(Object.assign(new Event(type), { persisted }));

afterEach(() => {
  opened.splice(0).forEach((c) => c.close());
  pageTransition('pagehide', false); // closes this page's channel so the worker can exit
});

describe('US-15 AC17f: cross-tab chat sync after a leave that does not happen', () => {
  it('a cancelled leave (beforeunload, then the page stays) keeps the chat hearing other tabs', async () => {
    const { subscribeSync, postSync } = await freshSync();
    const heard: unknown[] = [];
    subscribeSync((m) => heard.push(m));
    window.dispatchEvent(new Event('beforeunload'));
    const other = otherTab();
    other.post();
    postSync(fromHere);
    await settle();
    expect(heard).toEqual([fromOther]);
    expect(other.heard).toEqual([fromHere]);
  });

  it('a page in the back-forward cache hears nothing, and hears other tabs again once shown', async () => {
    const { subscribeSync } = await freshSync();
    const first: unknown[] = [];
    const second: unknown[] = [];
    subscribeSync((m) => first.push(m));
    subscribeSync((m) => second.push(m));
    const other = otherTab();
    window.dispatchEvent(new Event('beforeunload')); // a browser leaving for another page sends both
    pageTransition('pagehide', true);
    other.post();
    await settle();
    expect(first).toEqual([]);
    pageTransition('pageshow', true);
    other.post();
    await settle();
    expect(first).toEqual([fromOther]);
    expect(second).toEqual([fromOther]);
  });

  it('after the page is shown again, this tab still reaches other tabs', async () => {
    const { subscribeSync, postSync } = await freshSync();
    subscribeSync(() => {});
    const other = otherTab();
    pageTransition('pagehide', true);
    pageTransition('pageshow', true);
    postSync(fromHere);
    await settle();
    expect(other.heard).toEqual([fromHere]);
  });

  it('a chat that unsubscribes, before the page goes, while it is away or after it is shown again, hears nothing more', async () => {
    const { subscribeSync } = await freshSync();
    const leftBefore: unknown[] = [];
    const leftAway: unknown[] = [];
    const leftAfter: unknown[] = [];
    const stays: unknown[] = [];
    subscribeSync((m) => stays.push(m));
    subscribeSync((m) => leftBefore.push(m))();
    const leaveAway = subscribeSync((m) => leftAway.push(m));
    const leaveAfter = subscribeSync((m) => leftAfter.push(m));
    pageTransition('pagehide', true);
    expect(() => leaveAway()).not.toThrow();
    pageTransition('pageshow', true);
    leaveAfter();
    const other = otherTab();
    other.post();
    await settle();
    expect(stays).toEqual([fromOther]);
    expect(leftBefore).toEqual([]);
    expect(leftAway).toEqual([]);
    expect(leftAfter).toEqual([]);
  });

  it('a chat that subscribes after the page is shown again hears other tabs', async () => {
    const { subscribeSync } = await freshSync();
    subscribeSync(() => {});
    pageTransition('pagehide', true);
    pageTransition('pageshow', true);
    const heard: unknown[] = [];
    subscribeSync((m) => heard.push(m));
    const other = otherTab();
    other.post();
    await settle();
    expect(heard).toEqual([fromOther]);
  });
});
