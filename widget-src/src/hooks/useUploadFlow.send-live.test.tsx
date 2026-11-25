// @vitest-environment jsdom
/**
 * US-12 AC26, mount note (a): the upload flow hands the list's mount its `send` and `live`. `send` runs the shared
 * transition and sets `live.current` before it returns, so a read right after a choice (a commit by blur, then a
 * press) holds the change, before React renders it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { useUploadFlow } from './useUploadFlow';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
const shown = vi.hoisted(() => ({ erase: 'erase-at-press' }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'device-only'), getShownErase: () => shown.erase }));
const bundle = vi.hoisted(() => ({ next: new Promise<unknown>(() => {}) }));
vi.mock('../lib/upload-bundle', () => ({ createUploadBundleLoader: () => () => bundle.next }));
const shared = vi.hoisted(() => ({ sharedSave: vi.fn() }));
vi.mock('../lib/upload-shared-save', () => shared);
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);

describe('US-12 AC26: send and live for the list\'s mount', () => {
  it('a read of live.current right after send holds the change, before a render', () => {
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', onComplete: () => {}, onClose: () => {} }));
    const { send, live } = result.current;
    const seen: string[] = [];
    act(() => {
      send({ type: 'picked', files: [{ id: 'f0', name: 'synthetic.pdf', bytes: 1, kind: 'file' }], needsConsent: true, now: '2026-11-22T00:00:00.000Z' });
      seen.push(live.current.phase);
      send({ type: 'discard' });
      seen.push(live.current.phase);
    });
    expect(seen).toEqual(['consent', 'choosing']);
    expect(result.current.live.current.phase).toBe('choosing');
  });

  it('an event the state refuses leaves live.current as it was', () => {
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', onComplete: () => {}, onClose: () => {} }));
    const before = result.current.live.current;
    act(() => result.current.send({ type: 'saveStarted' }));
    expect(result.current.live.current).toBe(before);
  });
});

// US-16 AC2a (lead H18): the Save carries the erase the page showed at the press, in the flow's saving state; the
// store's Save reads it there (storage/upload-save-store.ts), never the page's mark when it runs.
describe('US-16 AC2a: Save reads the erase at the press', () => {
  it('the saving state holds the erase shown at the press, though the page shows another by the time the Save runs', () => {
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', onComplete: () => {}, onClose: () => {} }));
    const failed: UploadState = { phase: 'saveFailed', platform: 'web', run: 1, files: [], started: '2026-11-22T00:00:00.000Z', firstRead: null, attempt: 1, message: 'no' };
    result.current.live.current = failed;
    act(() => result.current.save([], {}));
    shown.erase = 'erase-shown-later';
    expect(result.current.live.current).toMatchObject({ phase: 'saving', attempt: 2, erase: 'erase-at-press' });
  });
});

// R5 PR 3: the web's Save takes its erase as a required part of its state (storage/upload-save-store.ts `WebSaving`).
// A saving state without one, which the web's own press never sends, is refused, never saved under another erase.
describe('US-16 AC2a: a Save whose state carries no erase', () => {
  const failed: UploadState = { phase: 'saveFailed', platform: 'web', run: 1, files: [], started: '2026-11-22T00:00:00.000Z', firstRead: null, attempt: 1, message: 'no' };
  it('is refused with the page\'s failed-save words, and nothing is saved', async () => {
    bundle.next = Promise.resolve({});
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', onComplete: () => {}, onClose: () => {} }));
    result.current.live.current = failed;
    await act(async () => { result.current.send({ type: 'saveStarted', reviewed: [] }); await bundle.next; });
    expect(shared.sharedSave).not.toHaveBeenCalled();
    expect(result.current.live.current).toMatchObject({ phase: 'saveFailed', attempt: 2, message: 'Failed to save. Please try again.' });
  });

  it('control: the press\'s own Save goes to the shared Save with the erase it read', async () => {
    shown.erase = 'erase-at-press';
    bundle.next = Promise.resolve({});
    shared.sharedSave.mockResolvedValue({ type: 'saveFailed', run: 1, attempt: 2, message: 'Synthetic' });
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', onComplete: () => {}, onClose: () => {} }));
    result.current.live.current = failed;
    await act(async () => { result.current.save([], {}); await bundle.next; });
    expect(shared.sharedSave).toHaveBeenCalledWith({}, expect.objectContaining({ phase: 'saving', erase: 'erase-at-press' }), expect.anything(), undefined, expect.any(Function));
  });
});
