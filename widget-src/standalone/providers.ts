/**
 * One record per cloud provider the standalone build can save to, so adding a
 * provider is one entry here. Its picker card (name, blurb, logo) is copy and
 * stays in backend-picker.tsx; Drive's in-place re-auth and its ID-token
 * reminders lane use the Google adapter's own API and stay where they run.
 */
import { DropboxAdapter, GitHubAdapter, GoogleDriveAdapter, WebDavAdapter, type StorageAdapter } from '../src/storage';
import type { ProductEventMetadata } from '../src/lib/server-api';
import type { LogOffId } from '../src/lib/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import type { Backend } from './connect';
import { CONFIG_KEY as DRIVE_CONFIG_KEY, TOKENS_KEY as DRIVE_TOKENS_KEY } from '../src/storage/drive';
import { CONFIG_KEY as DROPBOX_CONFIG_KEY, TOKEN_KEY as DROPBOX_TOKEN_KEY } from '../src/storage/dropbox';
import { CONFIG_KEY as GITHUB_CONFIG_KEY } from '../src/storage/github';
import { CONFIG_KEY as WEBDAV_CONFIG_KEY } from '../src/storage/webdav';

export type CloudBackend = Exclude<Backend, 'local'>;

interface Provider {
  /** The name the sync status line, the log-off copy and connect errors show. */
  label: string;
  /** A fresh adapter. Each reads its own stored token, so a bare one reconnects.
   *  `gen`: the log-off id a sign-in it starts began under (US-09 AC45). */
  adapter: (gen?: LogOffId) => StorageAdapter;
  /** Reminders need an account email the browser can read (§10). */
  reminders: boolean;
  /** The provider name product events carry. */
  event: Exclude<NonNullable<ProductEventMetadata['provider']>, 'local' | 'typed'>;
}

export const PROVIDERS = {
  dropbox: { label: 'Dropbox', adapter: (gen) => new DropboxAdapter(dropboxConfig(), gen), reminders: true, event: 'dropbox' },
  'google-drive': { label: 'Google Drive', adapter: (gen) => new GoogleDriveAdapter(googleDriveConfig(), gen), reminders: true, event: 'google-drive' },
  github: { label: 'GitHub', adapter: (gen) => new GitHubAdapter(undefined, gen), reminders: true, event: 'github' },
  'self-host': { label: 'your own server', adapter: (gen) => new WebDavAdapter(undefined, gen), reminders: false, event: 'webdav' },
} as const satisfies Record<CloudBackend, Provider>;

/** US-09 AC49: asked before "Use this browser only" starts an empty record. Your own server is "on", never
 *  "in your your own server" (owner ruling). */
export function noCopyQuestion(backend: CloudBackend): string {
  const where = backend === 'self-host' ? 'on your own server' : `in your ${PROVIDERS[backend].label}`;
  return `This browser has no copy of your record yet. It stays safe ${where}. Start empty in this browser?`;
}

/** Every provider's stored sign-in entries, for the page-load sweep and log-off (US-09 AC45). */
export const SIGN_IN_KEYS = [DRIVE_CONFIG_KEY, DRIVE_TOKENS_KEY, DROPBOX_CONFIG_KEY, DROPBOX_TOKEN_KEY, GITHUB_CONFIG_KEY, WEBDAV_CONFIG_KEY] as const;

/** A backend's entry; undefined for 'local' or a name with none. The
 *  remembered choice is unchecked storage text, so it may name anything. */
export function providerOf(backend: string): (typeof PROVIDERS)[CloudBackend] | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, backend) ? PROVIDERS[backend as CloudBackend] : undefined;
}

/** The providers whose account email reminders can read. */
export type ReminderBackend = { [K in CloudBackend]: (typeof PROVIDERS)[K]['reminders'] extends true ? K : never }[CloudBackend];
