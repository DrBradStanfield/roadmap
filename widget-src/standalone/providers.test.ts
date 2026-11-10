/**
 * The provider table (untangle W2-12): every cloud backend has one full entry,
 * and the callers that used to switch on the provider name read it. The table
 * type is `satisfies Record<CloudBackend, Provider>`, so a missing entry fails
 * the typecheck; EXPECTED below is a Record too, so a new provider must also
 * say here what a caller sees for it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage')>();
  return {
    ...actual,
    DropboxAdapter: class DropboxStub {},
    GoogleDriveAdapter: class GoogleDriveStub {},
    GitHubAdapter: class GitHubStub {},
    WebDavAdapter: class WebDavStub {},
  };
});

// The OAuth configs read `location`; the adapters are stubs, so a stub config does.
vi.mock('./dropbox-config', () => ({ dropboxConfig: () => ({}) }));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));

import { PROVIDERS, type CloudBackend } from './providers';
import { adapterFor, type Backend } from './connect';
import { remindersSupported } from './reminders';

const EXPECTED: Record<CloudBackend, { label: string; reminders: boolean; adapter: string; event: string }> = {
  dropbox: { label: 'Dropbox', reminders: true, adapter: 'DropboxStub', event: 'dropbox' },
  'google-drive': { label: 'Google Drive', reminders: true, adapter: 'GoogleDriveStub', event: 'google-drive' },
  github: { label: 'GitHub', reminders: true, adapter: 'GitHubStub', event: 'github' },
  'self-host': { label: 'your own server', reminders: false, adapter: 'WebDavStub', event: 'webdav' },
};

describe('provider table (W2-12)', () => {
  it('has exactly one entry per cloud backend', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED) as [CloudBackend, (typeof EXPECTED)[CloudBackend]][])(
    '%s: label, reminders support, adapter and event name',
    (backend, want) => {
      expect(PROVIDERS[backend].label).toBe(want.label);
      expect(remindersSupported(backend)).toBe(want.reminders);
      expect(adapterFor(backend)?.constructor.name).toBe(want.adapter);
      expect(PROVIDERS[backend].event).toBe(want.event);
    },
  );

  it('the on-device tier has no adapter and no reminders', () => {
    expect(adapterFor('local')).toBeNull();
    expect(remindersSupported('local')).toBe(false);
  });

  it('a remembered name with no entry (storage text) has neither, even an Object key', () => {
    for (const name of ['onedrive', 'toString', '__proto__'] as unknown as Backend[]) {
      expect(adapterFor(name)).toBeNull();
      expect(remindersSupported(name)).toBe(false);
    }
  });
});
