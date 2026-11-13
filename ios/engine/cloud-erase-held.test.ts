// S50b part 1 (US-25 AC16i): before Disconnect or a switch closes anything, the app asks
// cloudEraseHeld whether an erase made here is still unsent over a passing failure. Only
// 'transient' holds the Disconnect; 'definite', 'unknown' and 'none' let it run as today.
// Only a failure known to pass is 'transient' (owner, 2026-11-14): anything unrecognised is
// 'unknown'. The engine runs as in cloud.test.ts (cloud.test-helpers.ts), and the rule
// (cloud-adapters.ts eraseFailure) is tabled across every provider's statuses.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConflictError, StorageError, UNREACHABLE_HINT } from '../../packages/health-core/src/adapter';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import { eraseFailure } from './cloud-adapters';
import { HOLD_MS, holdsStill } from './cloud';
import { add, FakeDrive, FakeDropbox, NOW, phone, recordWith } from './cloud.test-helpers';

interface Erased { success: boolean; erased: boolean; view: { erase: string } | null }

/** Dropbox with one record, opened. */
async function dropboxOpen() {
  const dropbox = new FakeDropbox();
  dropbox.put(await recordWith(['2026-10-01'], 'web'));
  const { engine, state, advance } = await phone(dropbox);
  const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false, false)) as { erase: string };
  return { dropbox, engine, state, erase, advance };
}

/** Dropbox open, then an erase whose upload `refuse` makes fail: made here, not sent. */
async function eraseNotSent(refuse: (dropbox: FakeDropbox) => void) {
  const parts = await dropboxOpen();
  refuse(parts.dropbox);
  const result = JSON.parse(await parts.engine.cloudErase(null, NOW, () => '')) as Erased;
  expect(result).toMatchObject({ success: false, erased: true });
  expect(parts.dropbox.record.meta.eraseEpoch ?? 0).toBe(0);
  return { ...parts, shown: result.view!.erase };
}

describe('cloudEraseHeld (S50b, US-25 AC16i)', () => {
  it('an erase whose uploads fail with a 500 is held: transient', async () => {
    const { engine } = await eraseNotSent((dropbox) => { dropbox.uploadsWork = false; });
    expect(await engine.cloudEraseHeld()).toBe('transient');
  });

  it('an erase not sent, then the network gone: transient', async () => {
    const { dropbox, engine } = await eraseNotSent((d) => { d.uploadsWork = false; });
    dropbox.online = false;
    expect(await engine.cloudEraseHeld()).toBe('transient');
  });

  it('a full Dropbox is definite, so Disconnect runs as today', async () => {
    const { engine } = await eraseNotSent((dropbox) => { dropbox.full = true; });
    expect(await engine.cloudEraseHeld()).toBe('definite');
  });

  it('a refused token is definite (a revoked or signed-out grant never holds the person)', async () => {
    const { engine, state } = await eraseNotSent((dropbox) => { dropbox.uploadsWork = false; });
    state.signedOut = true;
    expect(await engine.cloudEraseHeld()).toBe('definite');
  });

  it('each ask flushes again and reads its own failure, never a stale one', async () => {
    const { dropbox, engine } = await eraseNotSent((d) => { d.full = true; });
    expect(await engine.cloudEraseHeld()).toBe('definite');
    dropbox.full = false;
    dropbox.uploadsWork = false;
    expect(await engine.cloudEraseHeld()).toBe('transient');
  });

  it('once uploads work the ask sends the erase: none, and the cloud holds eraseEpoch 1', async () => {
    const { dropbox, engine } = await eraseNotSent((d) => { d.uploadsWork = false; });
    expect(await engine.cloudEraseHeld()).toBe('transient');
    dropbox.uploadsWork = true;
    expect(await engine.cloudEraseHeld()).toBe('none');
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
    expect(await engine.cloudEraseHeld()).toBe('none');
  });

  it('an erase a later save sent, then a weight edit that fails: none (only an unsent erase holds)', async () => {
    const { dropbox, engine, shown } = await eraseNotSent((d) => { d.uploadsWork = false; });
    dropbox.uploadsWork = true;
    expect(await engine.cloudFlush()).toBe('saved');
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
    dropbox.uploadsWork = false;
    expect((JSON.parse(engine.cloudEdit(add('2026-10-05'), shown, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('failed');
    expect(await engine.cloudEraseHeld()).toBe('none');
  });

  it('an erase that landed, then a weight edit that fails: none', async () => {
    const { dropbox, engine } = await dropboxOpen();
    const result = JSON.parse(await engine.cloudErase(null, NOW, () => '')) as Erased;
    expect(result.success).toBe(true);
    dropbox.uploadsWork = false;
    expect((JSON.parse(engine.cloudEdit(add('2026-10-05'), result.view!.erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('failed');
    expect(await engine.cloudEraseHeld()).toBe('none');
  });

  it('no erase: a weight edit that fails holds nothing', async () => {
    const { dropbox, engine, erase } = await dropboxOpen();
    dropbox.uploadsWork = false;
    engine.cloudEdit(add('2026-10-05'), erase, 'si', NOW);
    expect(await engine.cloudFlush()).toBe('failed');
    expect(await engine.cloudEraseHeld()).toBe('none');
  });

  it('no session open: none', async () => {
    const { engine } = await phone(new FakeDropbox());
    expect(await engine.cloudEraseHeld()).toBe('none');
  });

  it('Drive: an erase whose token lapses after a PATCH that may have landed, refresh skipped, is unknown: no hold', async () => {
    const drive = new FakeDrive();
    drive.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(drive);
    await engine.cloudOpen('google-drive', 'ios-1', false, false);
    // Every PATCH lands, then the token lapses: the verify read answers 401, never retried (S57b).
    const lapse = (next: string) => (body: string) => {
      if (!body.includes('"eraseEpoch":1')) return false; // the record's PATCH, not the chat file's
      drive.bearer = next;
      state.refreshedToken = next;
      return true;
    };
    drive.afterPatch = lapse('token-2');
    expect(JSON.parse(await engine.cloudErase(null, NOW, () => '')) as Erased).toMatchObject({ success: false, erased: true });
    drive.afterPatch = lapse('token-3');
    expect(await engine.cloudEraseHeld()).toBe('unknown');
    // The next ask refreshes first and the save is verified: the erase is sent.
    expect(await engine.cloudEraseHeld()).toBe('none');
    expect(drive.record.meta.eraseEpoch).toBe(1);
  });

  // Review R1 (adversary and Codex): a save already in flight (a background flush, Sync now, or
  // the first of two Disconnect taps) is joined, never skipped, so its failure is the answer.
  it('a save in flight when the ask comes is joined: transient, not unknown', async () => {
    const { engine } = await eraseNotSent((dropbox) => { dropbox.uploadsWork = false; });
    const flushing = engine.cloudFlush();
    expect(await engine.cloudEraseHeld()).toBe('transient');
    expect(await flushing).toBe('failed');
  });

  it('two asks at once both wait for the save: transient twice', async () => {
    const { engine } = await eraseNotSent((dropbox) => { dropbox.uploadsWork = false; });
    expect(await Promise.all([engine.cloudEraseHeld(), engine.cloudEraseHeld()])).toEqual(['transient', 'transient']);
  });

  // Review R2: Drive wraps a PATCH's refusal ("record update failed.") and keeps the answer's
  // body only on its cause, so the rate limit is read through the chain.
  it('Drive: an erase whose record PATCH meets a rate limit is transient, through the real adapter', async () => {
    const drive = new FakeDrive();
    drive.put(await recordWith(['2026-10-01'], 'web'));
    const { engine } = await phone(drive);
    await engine.cloudOpen('google-drive', 'ios-1', false, false);
    let limited = true;
    const answer = drive.answer.bind(drive);
    drive.answer = (url, headers, body, method) => (limited && method === 'PATCH' && body?.includes('"eraseEpoch":1')
      ? { status: 403, headers: {}, body: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' }
      : answer(url, headers, body, method));
    expect(JSON.parse(await engine.cloudErase(null, NOW, () => '')) as Erased).toMatchObject({ success: false, erased: true });
    expect(await engine.cloudEraseHeld()).toBe('transient');
    limited = false;
    expect(await engine.cloudEraseHeld()).toBe('none');
    expect(drive.record.meta.eraseEpoch).toBe(1);
  });

  // Owner 2026-11-14: a failure nobody recognised allows Disconnect. One row per trap state.
  it('(i) the app’s own allow-list refusal reads unknown, never transient', async () => {
    const { dropbox, engine } = await eraseNotSent((d) => { d.uploadsWork = false; });
    dropbox.refusal = 'This app does not send that request.';
    expect(await engine.cloudEraseHeld()).toBe('unknown');
  });

  it('(ii) a Keychain that keeps refusing to save the refreshed token reads unknown', async () => {
    const { engine, state } = await eraseNotSent((d) => { d.uploadsWork = false; });
    state.tokenError = 'The operation couldn’t be completed. (HealthRoadmap.TokenStore.Failure error 0.)';
    expect(await engine.cloudEraseHeld()).toBe('unknown');
  });

  it('(iii) a token endpoint answering other than 400 or 401 reads unknown', async () => {
    const { engine, state } = await eraseNotSent((d) => { d.uploadsWork = false; });
    state.tokenError = 'Dropbox sign-in failed (503). Try again.';
    expect(await engine.cloudEraseHeld()).toBe('unknown');
  });

  it('a token refresh whose network call got no answer is transient, told apart from (ii) and (iii)', async () => {
    const { engine, state } = await eraseNotSent((d) => { d.uploadsWork = false; });
    state.tokenError = 'Dropbox did not answer. Check the connection and try again.';
    expect(await engine.cloudEraseHeld()).toBe('transient');
  });

  it('a genuine network failure is transient, told apart from the allow-list refusal', async () => {
    const { dropbox, engine } = await eraseNotSent((d) => { d.uploadsWork = false; });
    dropbox.online = false;
    expect(await engine.cloudEraseHeld()).toBe('transient');
    dropbox.online = true;
    dropbox.refusal = 'This app does not send that request.';
    expect(await engine.cloudEraseHeld()).toBe('unknown');
  });

  // Owner 2026-11-14: the hold lasts 24 hours from the erase's FIRST failed send, by time only.
  it('24 hours after the first failed send, the ask answers expired and Disconnect goes ahead as today', async () => {
    const { engine, advance } = await eraseNotSent((d) => { d.uploadsWork = false; });
    advance(HOLD_MS - 60_000);
    expect(await engine.cloudEraseHeld()).toBe('transient'); // a later failure never moves the start
    advance(60_000);
    expect(await engine.cloudEraseHeld()).toBe('expired');
    expect(await engine.cloudEraseHeld()).toBe('expired'); // more taps change nothing
    expect(await engine.cloudClose(true)).toBe('copied');
  });

  it('a second erase that fails while the first is held keeps the first one’s start', async () => {
    const { engine, advance } = await eraseNotSent((d) => { d.uploadsWork = false; });
    advance(HOLD_MS - 60_000);
    expect((JSON.parse(await engine.cloudErase(null, NOW, () => '')) as Erased).success).toBe(false);
    advance(60_000);
    expect(await engine.cloudEraseHeld()).toBe('expired');
  });

  it('an expired hold still flushes: a cloud that answers then takes the erase, and the answer is none', async () => {
    const { dropbox, engine, advance } = await eraseNotSent((d) => { d.uploadsWork = false; });
    advance(HOLD_MS + 1);
    dropbox.uploadsWork = true;
    expect(await engine.cloudEraseHeld()).toBe('none');
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
  });

  it('cloudClose still answers its four words, which builds 11 and 12 match', async () => {
    const { engine } = await eraseNotSent((dropbox) => { dropbox.uploadsWork = false; });
    expect(await engine.cloudClose(true)).toBe('copied');
    expect(await engine.cloudClose(true)).toBe('none');
  });
});

// The bound's pure rule: `now` is passed in, it reads no clock. 24 hours falls on the allow side.
describe('the 24-hour bound (S50b, owner 2026-11-14)', () => {
  const since = Date.parse('2026-11-14T08:00:00.000Z');
  it.each([
    ['just under 24 hours: still holds', since + HOLD_MS - 1, true],
    ['exactly 24 hours: no longer holds', since + HOLD_MS, false],
    ['just over 24 hours: no longer holds', since + HOLD_MS + 1, false],
    ['the clock set backwards (a negative age): within the bound, so it holds', since - 3_600_000, true],
    ['at the first failed send itself: holds', since, true],
  ])('%s', (_name, now, holds) => {
    expect(holdsStill(since, now)).toBe(holds);
  });
  it('the bound is 24 hours', () => expect(HOLD_MS).toBe(24 * 60 * 60 * 1000));
});

describe('the bridge keeps its id with the new door (S50b)', () => {
  const here = __dirname;
  it('bridge-contract.json still hashes to 40fc97db4ca12547, and cloudClose is unchanged in it', () => {
    const bytes = readFileSync(join(here, 'bridge-contract.json'));
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toBe('40fc97db4ca12547');
    const contract = JSON.parse(bytes.toString('utf8')) as { doors: Record<string, unknown> };
    expect(contract.doors.cloudClose).toEqual({ args: ['copyDown'], returns: 'Promise of JSON' });
    expect(contract.doors.cloudEraseHeld).toBeUndefined();
  });

  it('cloudEraseHeld is an optional door with no arguments', () => {
    const optional = JSON.parse(readFileSync(join(here, 'bridge-optional.json'), 'utf8')) as { optionalDoors: Record<string, { args: string[]; returns: string }> };
    expect(optional.optionalDoors.cloudEraseHeld.args).toEqual([]);
    expect(optional.optionalDoors.cloudEraseHeld.returns).toMatchSnapshot();
  });
});

// The rule, by what each provider's adapter throws (dropbox-rest.ts, drive-rest*.ts, and the
// web's github.ts and webdav.ts). 'transient' only for a failure known to pass: no answer at all
// (fetch never answered, a timeout, an abort), 408, 429, 5xx, Google's rate or daily limit.
// 'definite' for a provider's refusal; 'unknown' for anything else. Only 'transient' holds.
type Word = 'transient' | 'definite' | 'unknown';
const status = (provider: string, code: number, body = '') => new StorageError(`${provider} write failed (${code}): ${body}`, undefined, undefined, code);
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const noAnswer = (provider: string, cause: unknown = new TypeError('The Internet connection appears to be offline.')) =>
  new StorageError(`${provider} did not answer`, UNREACHABLE_HINT, cause);
const transport = (provider: string): Array<[string, unknown, Word]> => [
  [`${provider}: no network`, noAnswer(provider), 'transient'],
  [`${provider}: a timeout`, noAnswer(provider, named('TimeoutError', 'The operation timed out.')), 'transient'],
  [`${provider}: an abort`, noAnswer(provider, named('AbortError', 'This operation was aborted')), 'transient'],
  [`${provider}: a write with no answer, which may have landed`, new StorageError(`${provider} did not answer`, 'The change may have landed.', new TypeError('offline')), 'transient'],
  [`${provider}: no answer, rewrapped by the save after an earlier write`, new StorageError(`${provider} did not answer`, 'check what landed', noAnswer(provider)), 'transient'],
  [`${provider}: (i) the app's allow-list refusal, a TypeError like a network failure`, noAnswer(provider, new TypeError('This app does not send that request.')), 'unknown'],
  [`${provider}: no token for the request`, noAnswer(provider, new TypeError('Not signed in.')), 'unknown'],
  [`${provider}: (ii) a token failure Swift did not call an outage (a Keychain that will not save)`, new StorageError('The operation couldn’t be completed.', UNREACHABLE_HINT), 'unknown'],
  [`${provider}: (iii) a token endpoint answering 503`, new StorageError(`${provider} sign-in failed (503). Try again.`, UNREACHABLE_HINT), 'unknown'],
  [`${provider}: 408`, status(provider, 408), 'transient'],
  [`${provider}: 429`, status(provider, 429), 'transient'],
  [`${provider}: 500`, status(provider, 500), 'transient'],
  [`${provider}: 502`, status(provider, 502), 'transient'],
  [`${provider}: 503`, status(provider, 503), 'transient'],
  [`${provider}: 400`, status(provider, 400), 'definite'],
  [`${provider}: 404`, status(provider, 404), 'definite'],
  [`${provider}: 413`, status(provider, 413), 'definite'],
  [`${provider}: a conflict storm`, new StorageError('Save failed after 5 attempts — a sync conflict storm', 'Try again.', new ConflictError()), 'unknown'],
  [`${provider}: a file that is not JSON`, new StorageError(`${provider} read failed: file is not valid JSON (possible corruption).`, undefined, new SyntaxError('bad')), 'unknown'],
  [`${provider}: a newer schema`, new SchemaTooNewError(9, 3), 'definite'],
  [`${provider}: a bug of ours`, new TypeError('x is undefined'), 'unknown'],
];

describe.each<[string, Array<[string, unknown, Word]>]>([
  ['Dropbox', [
    ...transport('Dropbox'),
    ['Dropbox: a revoked or signed-out grant is definite', new StorageError('Dropbox refused the sign-in.', undefined, undefined, 401), 'definite'],
    ['Dropbox: a signed-out web session (reason reconnect) is definite', new StorageError('Dropbox session expired — please reconnect.', undefined, undefined, undefined, 'reconnect'), 'definite'],
    ['Dropbox: full (409 insufficient_space)', new StorageError('Dropbox is full', 'Free up space', undefined, 409, 'storage-full'), 'definite'],
    ['Dropbox: another 409', status('Dropbox', 409, 'path/malformed_path/'), 'definite'],
    ['Dropbox: 403', status('Dropbox', 403), 'definite'],
    ['Dropbox: a write that returned no rev', new StorageError('Dropbox write returned no rev.'), 'unknown'],
  ]],
  ['Google Drive', [
    ...transport('Google Drive'),
    ['Google Drive: a revoked or signed-out grant is definite', new StorageError('Google Drive needs you to sign in again.', undefined, undefined, 401), 'definite'],
    ['Google Drive: a web grant gone (reason reconnect) is definite', new StorageError('Google Drive needs to be reconnected.', undefined, undefined, undefined, 'reconnect'), 'definite'],
    ['Google Drive: 403 rateLimitExceeded', status('Google Drive', 403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}'), 'transient'],
    ['Google Drive: 403 userRateLimitExceeded', status('Google Drive', 403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'), 'transient'],
    ['Google Drive: 403 dailyLimitExceeded', status('Google Drive', 403, '{"error":{"errors":[{"reason":"dailyLimitExceeded"}]}}'), 'transient'],
    ['Google Drive: 403 dailyLimitExceededUnreg (no valid credentials) is definite', status('Google Drive', 403, '{"error":{"errors":[{"reason":"dailyLimitExceededUnreg"}]}}'), 'definite'],
    ['Google Drive: 403 storageQuotaExceeded (full)', status('Google Drive', 403, '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}'), 'definite'],
    ['Google Drive: 403 insufficientPermissions', status('Google Drive', 403, '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}'), 'definite'],
    ['Google Drive: a damaged copy pauses saving', new StorageError('A copy of the record in Google Drive could not be read, so saving is paused.', 'Saving resumes once it is repaired.'), 'unknown'],
    ['Google Drive: an incomplete record enumeration', new StorageError('Google Drive record enumeration is incomplete.'), 'unknown'],
  ]],
  ['GitHub', [
    ...transport('GitHub'),
    ['GitHub: a revoked or signed-out grant is definite', new StorageError('GitHub rejected the token — check it has Contents read+write on this repo.', undefined, undefined, 401), 'definite'],
    ['GitHub: a token without access (403), its rate limit included, is definite', new StorageError('GitHub rejected the token', undefined, undefined, 403), 'definite'],
    ['GitHub: the repo not found (404)', new StorageError('GitHub repo not found', undefined, undefined, 404), 'definite'],
    ['GitHub: 422', status('GitHub', 422), 'definite'],
    ['GitHub: not connected', new StorageError('GitHub is not connected.'), 'unknown'],
    ['GitHub: a file over 1 MB', new StorageError('GitHub read failed: the file is larger than the 1 MB the Contents API returns inline.'), 'unknown'],
  ]],
  ['Self-host (WebDAV)', [
    ...transport('Self-host'),
    ['Self-host: a revoked or signed-out grant is definite', new StorageError('Self-host rejected the credentials.', undefined, undefined, 401), 'definite'],
    ['Self-host: 403', status('Self-host', 403), 'definite'],
    ['Self-host: 405', status('Self-host', 405), 'definite'],
    ['Self-host: 409 (no parent folder)', status('Self-host', 409), 'definite'],
    ['Self-host: 507 Insufficient Storage reads as a 5xx', status('Self-host', 507), 'transient'],
    ['Self-host: not connected', new StorageError('Self-host is not connected.'), 'unknown'],
  ]],
])('the erase-failure rule: %s', (_provider, rows) => {
  it.each(rows)('%s', (_name, error, word) => {
    expect(eraseFailure(error)).toBe(word);
  });
});
