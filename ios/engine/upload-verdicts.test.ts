// Shared upload PR 3 (US-52 AC7): the optional door uploadVerdictsJson answers the phone's
// golden pins (packages/health-core/src/__fixtures__/upload-decisions.json, unedited), in order.
import { describe, expect, it } from 'vitest';
import table from '../../packages/health-core/src/__fixtures__/upload-decisions.json';
import { uploadVerdictsJson } from './entry';

describe('uploadVerdictsJson (optional door)', () => {
  it('answers the phone\'s verdicts for each pinned file and ZIP member, in order, with its limits', () => {
    const files = [
      ...table.fileSizes.rows.map(({ name, bytes }) => ({ name, bytes })),
      ...table.fileKinds.rows.map(({ name }) => ({ name, bytes: 1 })),
    ];
    const answer = JSON.parse(uploadVerdictsJson(JSON.stringify({ files, zipMembers: table.zipMembers.rows.map((r) => r.path) })));
    expect(answer.limits).toMatchObject(table.limits.phone);
    expect(answer.files).toEqual([
      ...table.fileSizes.rows.map((r) => (r.phone === 'fits' ? 'keep' : 'tooLarge')),
      ...table.fileKinds.rows.map((r) => (r.phone === 'unsupported' ? 'unsupported' : 'keep')),
    ]);
    expect(answer.zipMembers.map((v: string) => v === 'keep')).toEqual(table.zipMembers.rows.map((r) => r.phone));
  });

  it('answers empty lists for a request that names none', () => {
    expect(JSON.parse(uploadVerdictsJson('{}'))).toMatchObject({ files: [], zipMembers: [] });
  });
});
