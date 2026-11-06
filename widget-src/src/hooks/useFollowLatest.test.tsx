// @vitest-environment jsdom
/**
 * US-15 AC55: `useFollowLatest` remembers where the reader was (read on scroll)
 * only for the messages element and the conversation it was read in. Another
 * element (a remount) or another conversation in the same element is read as it
 * stands, as the chat did before. Layout stand-in: each box has its own heights.
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFollowLatest } from './useFollowLatest';

/** One stable messages array per change number, as the chat hands the hook its state.messages. */
const M = Array.from({ length: 10 }, (_, i) => [{ id: `m${i}` }]);

function box(scrollHeight: number, scrollTop: number, clientHeight = 400): HTMLElement {
  const el = document.createElement('div');
  let top = scrollTop;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, scrollHeight - clientHeight)); } });
  return el;
}

describe('US-15 AC55: useFollowLatest', () => {
  it('a list it has not seen is read as it stands: opened at the top of a long conversation, it stays there', () => {
    const first = box(500, 100); // at the bottom of a short list
    const ref = { current: first as HTMLElement | null };
    const { rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    expect(first.scrollTop).toBe(100);
    const second = box(3000, 0); // a remounted list, at its top
    ref.current = second;
    rerender({ n: 1 });
    expect(second.scrollTop).toBe(0);
  });

  it('a list it has not seen, already near its bottom, is followed', () => {
    const ref = { current: box(500, 100) as HTMLElement | null };
    const { rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    const second = box(600, 150); // 50px above its bottom
    ref.current = second;
    rerender({ n: 1 });
    expect(second.scrollTop).toBe(200);
  });

  it('a list it has not seen, exactly 100px above its bottom, is not followed', () => {
    const ref = { current: box(500, 100) as HTMLElement | null };
    const { rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    const second = box(600, 100); // 600 - 100 - 400 = 100
    ref.current = second;
    rerender({ n: 1 });
    expect(second.scrollTop).toBe(100);
  });

  it('the jump button shows only once the reader is more than 100px above the bottom', () => {
    const el = box(1000, 600);
    const ref = { current: el as HTMLElement | null };
    const { result } = renderHook(() => useFollowLatest(ref, 'c1', M[0], []));
    const at = (distance: number) => {
      act(() => { el.scrollTop = 600 - distance; result.current.onScroll(); });
      return result.current.showScrollBtn;
    };
    expect([at(0), at(100), at(101), at(100)]).toEqual([false, false, true, false]);
  });

  it('a reading belongs to its conversation: scrolled up in one, the next one is read as it stands', () => {
    const el = box(1000, 0); // scrolled to the top of c1
    const ref = { current: el as HTMLElement | null };
    const { result, rerender } = renderHook(({ c, n }) => useFollowLatest(ref, c, M[n], []), { initialProps: { c: 'c1', n: 0 } });
    act(() => result.current.onScroll());
    rerender({ c: 'c1', n: 1 }); // more in c1: the reader scrolled away, so no follow
    expect(el.scrollTop).toBe(0);
    rerender({ c: 'c2', n: 2 }); // c2 shown, still 600px up: read as it stands, no follow
    expect(el.scrollTop).toBe(0);
    const near = box(450, 0); // c3 shown in a new short list, 50px from its bottom
    ref.current = near;
    rerender({ c: 'c3', n: 3 });
    expect(near.scrollTop).toBe(50);
  });

  it('a reading belongs to its element: after a remount in the same conversation the new list is read as it stands', () => {
    const first = box(1000, 0); // scrolled to the top
    const ref = { current: first as HTMLElement | null };
    const { result, rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    act(() => result.current.onScroll());
    const second = box(450, 0); // remounted, 50px from its bottom
    ref.current = second;
    rerender({ n: 1 });
    expect(second.scrollTop).toBe(50);
  });

  it('a list that mounts with nothing else changed is read when it mounts (the bubble\'s History, then Back)', () => {
    const ref = { current: box(1000, 0) as HTMLElement | null }; // the first list, scrolled to its top
    const { result, rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    act(() => result.current.onScroll());
    let height = 300; // the list mounted by Back: everything fits, so it never scrolls
    let top = 0;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
    ref.current = el;
    rerender({ n: 0 }); // same messages and changes: only the element is new
    height = 1200; // a pasted report lands
    rerender({ n: 1 });
    expect(top).toBe(800);
  });

  it('a list that mounts 100px or more above its bottom is read as not at the latest, and is left in place', () => {
    const ref = { current: box(500, 100) as HTMLElement | null }; // the first list, at its bottom
    const { rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    let height = 500; // mounted at its top: 500 - 0 - 400 = 100
    let top = 0;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
    ref.current = el;
    rerender({ n: 0 });
    height = 450; // shorter now, 50px from the bottom: a reading taken only now would follow
    rerender({ n: 1 });
    expect(top).toBe(0);
  });

  it('a list that never scrolled (everything fits) is followed when a long message lands', () => {
    let height = 300; // shorter than the box: a browser fires no scroll event
    let top = 0;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
    const ref = { current: el as HTMLElement | null };
    const { rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    height = 1200; // a pasted report lands
    rerender({ n: 1 });
    expect(top).toBe(800);
  });

  it('a change of conversation id alone reads nothing: the next conversation is read once its messages are shown', () => {
    let height = 500;
    let top = 100;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
    const ref = { current: el as HTMLElement | null };
    const { rerender } = renderHook(({ c, n }) => useFollowLatest(ref, c, M[n], []), { initialProps: { c: 'c1', n: 0 } });
    rerender({ c: 'c2', n: 0 }); // c2 chosen, its messages still loading: c1's list, at its bottom, still shown
    height = 3000; // c2's long history arrives
    rerender({ c: 'c2', n: 1 });
    expect(top).toBe(100);
  });

  it('a reading taken while one conversation is on screen is filed under it, even after the id has moved on (a reply was streaming)', () => {
    let height = 500;
    let top = 100;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
    const ref = { current: el as HTMLElement | null };
    const { rerender } = renderHook(({ c, n, p }) => useFollowLatest(ref, c, M[n], [p]), { initialProps: { c: 'c1', n: 0, p: 'streaming' } });
    rerender({ c: 'c2', n: 0, p: 'none' }); // c2 chosen mid-reply: the pending reply clears, c1's messages still shown
    height = 3000; // c2's long history arrives
    rerender({ c: 'c2', n: 1, p: 'none' });
    expect(top).toBe(100);
  });

  it('a scroll made while the next conversation loads is filed under the one on screen', () => {
    let height = 500;
    let top = 100;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height - 400)); } });
    const ref = { current: el as HTMLElement | null };
    const { result, rerender } = renderHook(({ c, n }) => useFollowLatest(ref, c, M[n], []), { initialProps: { c: 'c1', n: 0 } });
    rerender({ c: 'c2', n: 0 }); // c2 chosen, still loading
    act(() => { top = 95; result.current.onScroll(); }); // the reader nudges c1's list, still near its bottom
    height = 3000; // c2 arrives
    rerender({ c: 'c2', n: 1 });
    expect(top).toBe(95);
  });

  it('a reading at the bottom is used when the list grows past 100px in one go', () => {
    let height = 500;
    let top = 100;
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.min(v, height - 400); } });
    const ref = { current: el as HTMLElement | null };
    const { result, rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    act(() => result.current.onScroll()); // at the bottom
    height = 1200; // a pasted report lands
    rerender({ n: 1 });
    expect(top).toBe(800);
  });

  it('with no list mounted it does nothing and says no jump button', () => {
    const ref = { current: null as HTMLElement | null };
    const { result, rerender } = renderHook(({ n }) => useFollowLatest(ref, 'c1', M[n], []), { initialProps: { n: 0 } });
    rerender({ n: 1 });
    result.current.onScroll();
    expect(result.current.showScrollBtn).toBe(false);
  });
});
