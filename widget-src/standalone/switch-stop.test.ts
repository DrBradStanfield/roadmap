/**
 * US-09 AC56: the picker's switch stop names one cause, read by type from the caught copy-down failure and
 * from whether this browser still takes the record's writes. The errors are the adapters' own, from their
 * real code paths: a Dropbox page after another tab's log-off has no stored token, so its copy-down fails at
 * the cloud read, before any device write. Synthetic values; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from '@roadmap/health-core/adapter';
import { DropboxAdapter } from '../src/storage/dropbox';
import { GitHubAdapter } from '../src/storage/github';
import { WritesStoppedError } from '../src/lib/error-diagnostics';
import { WRITES_STOPPED_CASES } from '../src/testing/writes-stopped-cases';
import { switchStopCause, type SwitchStop } from './switch-stop';

let local: Map<string, string>;
beforeEach(() => {
  local = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
    key: (i: number) => [...local.keys()][i] ?? null,
    get length() { return local.size; },
  } as unknown as Storage);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function readFailure(read: () => Promise<unknown>): Promise<unknown> {
  try {
    await read();
  } catch (error) {
    return error;
  }
  throw new Error('the read did not fail');
}

describe('switchStopCause (US-09 AC56)', () => {
  it('US-09 AC56: a Dropbox sign-in forgotten by another tab fails its read as a refused sign-in', async () => {
    const error = await readFailure(() => new DropboxAdapter({ clientId: 'synthetic', redirectUri: 'https://example.test/' }).read('roadmap.json'));
    expect(error).toBeInstanceOf(StorageError);
    expect(switchStopCause(error, false)).toEqual({ kind: 'writesRefused' });
    expect(switchStopCause(error, true)).toEqual({ kind: 'signInRefused' });
  });

  const cases: Array<[string, () => unknown, boolean, SwitchStop['kind']]> = [
    ['the device write refused after a log-off', () => new WritesStoppedError(), false, 'writesRefused'],
    ['any failure once this browser takes no writes', () => new TypeError('Failed to fetch'), false, 'writesRefused'],
    ['a token the provider refused (auth)', () => new StorageError('refused', undefined, undefined, 401, undefined, 'refused'), true, 'signInRefused'],
    ['a sign-in only a new one mends (reconnect)', () => new StorageError('reconnect', undefined, undefined, 400, 'reconnect', 'refused'), true, 'signInRefused'],
    ['access refused (forbidden)', () => new StorageError('forbidden', undefined, undefined, 403, undefined, 'refused'), true, 'unreachable'],
    ['a provider that did not answer', () => new StorageError('down', undefined, undefined, 503, undefined, 'no-answer'), true, 'unreachable'],
    ['a dead network', () => new TypeError('Failed to fetch'), true, 'unreachable'],
    ['a device write refused for room', () => new StorageError('full', undefined, undefined, undefined, undefined, 'refused'), true, 'unreachable'],
    ['anything else thrown', () => 'not an error', true, 'unreachable'],
  ];
  it.each(cases)('US-09 AC56: %s', (_name, make, writesAllowed, kind) => {
    expect(switchStopCause(make(), writesAllowed)).toEqual({ kind });
  });

  // US-09 AC64: the switch is the fifth log-off reader. It reads AC59's typed reason, as the other four do, so a
  // refusal reads the same wherever the page meets it. Reported rows are the ones the switch does not call a log-off.
  it.each(WRITES_STOPPED_CASES)('US-09 AC64: $name, while this browser still takes writes', ({ error, reports }) => {
    expect(switchStopCause(error(), true)).toEqual({ kind: reports === 0 ? 'writesRefused' : 'unreachable' });
  });

  it('US-09 AC56: a GitHub page with no stored sign-in fails its read with no typed reason, so it stays unreachable', async () => {
    const error = await readFailure(() => new GitHubAdapter().read('roadmap.json'));
    expect(switchStopCause(error, true)).toEqual({ kind: 'unreachable' });
    expect(switchStopCause(error, false)).toEqual({ kind: 'writesRefused' });
  });
});
