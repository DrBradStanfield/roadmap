/**
 * Untangle fix 4, the transport: a save loop's passes told to the page as one
 * change (record-host.ts laterChange, announce; US-16 AC2a, US-34 AC1).
 */
import { describe, it, expect, vi } from 'vitest';
import { announce, laterChange, type RecordHost } from './record-host';

describe('laterChange: two changes taken in before the page hears, as one', () => {
  it.each([
    [null, null, null],
    [null, { erase: null }, { erase: null }],
    [null, { erase: 'a' }, { erase: 'a' }],
    [{ erase: 'a' }, null, { erase: 'a' }],
    [{ erase: 'a' }, { erase: null }, { erase: 'a' }], // a later pass with no erase keeps the earlier one's
    [{ erase: 'a' }, { erase: 'b' }, { erase: 'b' }],
    [{ erase: null }, { erase: 'b' }, { erase: 'b' }],
  ])('laterChange(%o, %o) is %o', (prior, next, joined) => {
    expect(laterChange(prior, next)).toEqual(joined);
  });
});

describe('announce: the page hears a change, and nothing for none', () => {
  it('calls remoteChanged with the change, once, and never for null', () => {
    const remoteChanged = vi.fn();
    const host = { remoteChanged } as unknown as RecordHost;
    announce(host, null);
    expect(remoteChanged).not.toHaveBeenCalled();
    announce(host, { erase: 'a' });
    expect(remoteChanged.mock.calls).toEqual([[{ erase: 'a' }]]);
  });
});
