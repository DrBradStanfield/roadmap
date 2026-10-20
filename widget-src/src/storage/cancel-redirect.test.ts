/**
 * US-09 AC22: Cancel or Deny at Google or Dropbox returns `?error=access_denied`
 * with no code. It counts only for a flow THIS tab started, once, and the error
 * params leave the URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveAdapter } from './drive';
import { DropboxAdapter } from './dropbox';

const replaceState = vi.fn();

function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

function landOn(search: string, pkceKey?: string): void {
  vi.stubGlobal('sessionStorage', makeStorage());
  if (pkceKey) sessionStorage.setItem(pkceKey, JSON.stringify({ verifier: 'v', state: 's' }));
  vi.stubGlobal('window', { location: { search, pathname: '/pages/roadmap', hash: '' }, history: { replaceState } });
}

describe('claimCancelledRedirect (US-09 AC22)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('Google: counts a matching Cancel once and strips the error params', () => {
    landOn('?error=access_denied&state=s&utm=x', 'health_roadmap_gdrive_pkce');
    expect(GoogleDriveAdapter.claimCancelledRedirect()).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({}, '', '/pages/roadmap?utm=x');
    expect(sessionStorage.getItem('health_roadmap_gdrive_pkce')).toBeNull();
    expect(GoogleDriveAdapter.claimCancelledRedirect()).toBe(false); // entry consumed: a reload cannot recount
  });

  it('Dropbox: counts a matching Cancel', () => {
    landOn('?error=access_denied&state=s', 'health_roadmap_dropbox_pkce');
    expect(DropboxAdapter.claimCancelledRedirect()).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({}, '', '/pages/roadmap');
  });

  it('ignores a random ?error with no pending flow', () => {
    landOn('?error=access_denied&state=s');
    expect(GoogleDriveAdapter.claimCancelledRedirect()).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("ignores a state that does not match, and the other provider's flow", () => {
    landOn('?error=access_denied&state=forged', 'health_roadmap_gdrive_pkce');
    expect(GoogleDriveAdapter.claimCancelledRedirect()).toBe(false);
    landOn('?error=access_denied&state=s', 'health_roadmap_gdrive_pkce');
    expect(DropboxAdapter.claimCancelledRedirect()).toBe(false);
  });

  it('ignores other errors and a return that carries a code', () => {
    landOn('?error=server_error&state=s', 'health_roadmap_gdrive_pkce');
    expect(GoogleDriveAdapter.claimCancelledRedirect()).toBe(false);
    landOn('?error=access_denied&code=c&state=s', 'health_roadmap_gdrive_pkce');
    expect(GoogleDriveAdapter.claimCancelledRedirect()).toBe(false);
  });
});
