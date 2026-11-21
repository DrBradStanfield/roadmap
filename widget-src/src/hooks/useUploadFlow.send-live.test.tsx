// @vitest-environment jsdom
/**
 * US-12 AC26, mount note (a): the upload flow hands the list's mount its `send` and `live`. `send` runs the shared
 * transition and sets `live.current` before it returns, so a read right after a choice (a commit by blur, then a
 * press) holds the change, before React renders it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useUploadFlow } from './useUploadFlow';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'device-only') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);

describe('US-12 AC26: send and live for the list\'s mount', () => {
  it('a read of live.current right after send holds the change, before a render', () => {
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', history: { measurements: [], labValues: [], documents: [] }, onComplete: () => {}, onClose: () => {} }));
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
    const { result } = renderHook(() => useUploadFlow({ unitSystem: 'si', history: { measurements: [], labValues: [], documents: [] }, onComplete: () => {}, onClose: () => {} }));
    const before = result.current.live.current;
    act(() => result.current.send({ type: 'saveStarted' }));
    expect(result.current.live.current).toBe(before);
  });
});
