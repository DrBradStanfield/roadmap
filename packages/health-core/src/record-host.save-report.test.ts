/**
 * US-09 AC58: a failed save is reported once per cause and grant. The pure
 * rule (`shouldReport`) as a table, then the key `reportSaveFailure` builds
 * from the error's typed fields on each tier.
 */
import { describe, expect, it } from 'vitest';
import { StorageError } from './adapter';
import { reportSaveFailure, shouldReport, type RecordHost, type SaveReportKey } from './record-host';

describe('US-09 AC58: shouldReport, once per cause and grant', () => {
  const a: SaveReportKey = { cause: 'StorageError/reconnect/refused/', grant: 'dropbox' };
  it.each<[string, SaveReportKey | null, SaveReportKey, boolean]>([
    ['the first failure', null, a, true],
    ['the same cause under the same grant', a, { ...a }, false],
    ['a new cause under the same grant', a, { ...a, cause: 'StorageError//no-answer/' }, true],
    ['the same cause under a new grant', a, { ...a, grant: 'google-drive' }, true],
    ['a new cause and a new grant', a, { cause: 'x', grant: 'y' }, true],
  ])('%s', (_name, previous, now, reports) => {
    expect(shouldReport(previous, now)).toBe(reports);
  });
});

describe('US-09 AC58: reportSaveFailure reports under that key', () => {
  function host(tier: 'device' | 'cloud') {
    const seen: Array<{ cause?: string; repeat: boolean }> = [];
    const h = { tier, failureCause: () => 'QuotaExceededError', report: (_e: unknown, at: { cause?: string; repeat: boolean }) => void seen.push({ cause: at.cause, repeat: at.repeat }) } as unknown as RecordHost;
    return { h, seen };
  }
  const revoked = () => new StorageError('revoked', undefined, undefined, 401, 'reconnect', 'refused');
  const offline = () => new StorageError('offline', undefined, undefined, undefined, undefined, 'no-answer');

  it('a cloud failure that repeats is reported once; a new cause, then a new grant, report again', () => {
    const { h, seen } = host('cloud');
    let key = reportSaveFailure(h, revoked(), null, 'dropbox');
    key = reportSaveFailure(h, revoked(), key, 'dropbox');
    key = reportSaveFailure(h, offline(), key, 'dropbox');
    reportSaveFailure(h, offline(), key, 'google-drive');
    expect(seen).toEqual([
      { cause: undefined, repeat: false },
      { cause: undefined, repeat: true },
      { cause: undefined, repeat: false },
      { cause: undefined, repeat: false },
    ]);
  });

  it('the device tier still tags its refusal, and repeats the same refusal', () => {
    const { h, seen } = host('device');
    const full = () => new StorageError('full', undefined, new DOMException('q', 'QuotaExceededError'), undefined, undefined, 'refused');
    const key = reportSaveFailure(h, full(), null, 'local');
    reportSaveFailure(h, full(), key, 'local');
    expect(seen).toEqual([{ cause: 'QuotaExceededError', repeat: false }, { cause: 'QuotaExceededError', repeat: true }]);
  });
});
