// US-64 (lead A1-2): a pin written on main before the time and stamp
// primitives left merge.ts. For 200 seeded pairs of small records, each merge
// result's digest must match the snapshot main wrote. A move that changes one
// byte of what mergeFiles returns, in either order, fails here.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mergeFiles } from './merge';
import {
  createEmptyFile,
  stableStringify,
  type RoadmapFile,
  type FileMeasurement,
  type FileLabValue,
  type FileMedication,
  type FileDocument,
} from './roadmap-file';

/** mulberry32: a small seeded generator, so every run draws the same pairs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stamps in every spelling the clock order reads: zones, no zone, a space,
// fractions, a date alone, the empty unknown and one that does not parse.
const STAMPS = [
  '2026-05-01T08:00:00Z',
  '2026-05-01T08:00:00.000Z',
  '2026-05-01T20:00:00+12:00',
  '2026-05-01 08:00:00+00',
  '2026-05-01T08:00:00',
  '2026-05-01T09:30:00.5Z',
  '2026-05-02T00:00:00Z',
  '2026-05-02',
  '2026-04-30T23:59:59-05:00',
  '',
  'not a stamp',
];
const DAYS = ['2026-05-01', '2026-05-02', '2026-05-01T22:00:00Z'];
const METRICS = ['weight', 'waist'];
const LABS = ['ferritin', 'ldl'];

function smallFile(r: () => number, side: string): RoadmapFile {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const n = (max: number) => Math.floor(r() * (max + 1));
  const id = () => `row_${n(5)}${r() < 0.15 ? '#dup-0000abcd' : ''}`;
  const file = createEmptyFile({ deviceId: `dev_${side}`, now: pick(STAMPS) || '2026-01-01T00:00:00Z' });
  file.meta.lamport = n(4);
  if (r() < 0.25) file.meta.eraseEpoch = n(2);
  if (r() < 0.2) file.meta.erasedAt = pick(STAMPS);
  if (r() < 0.2) file.erasedRows = { fromEpoch: n(2), ids: [`row_${n(5)}`] };
  file.measurements = Array.from({ length: n(4) }, (): FileMeasurement => ({
    id: id(), metricType: pick(METRICS), value: 70 + n(3), recordedAt: pick(DAYS), createdAt: pick(STAMPS),
    source: 'manual', status: r() < 0.2 ? 'entered-in-error' : 'active', correctsId: null, externalId: null,
  }));
  file.labValues = Array.from({ length: n(3) }, (): FileLabValue => ({
    id: id(), metricName: pick(LABS), value: 1 + n(3), unit: 'x', referenceLow: null, referenceHigh: null,
    recordedAt: pick(DAYS), createdAt: pick(STAMPS), source: 'manual',
    status: r() < 0.2 ? 'entered-in-error' : 'active', correctsId: null,
  }));
  const med = (): FileMedication => ({
    id: id(), medicationKey: pick(['statin', 'ezetimibe']), drugName: pick(['a', 'b']), doseValue: n(2), doseUnit: 'mg',
    updatedAt: pick(STAMPS), ...(r() < 0.7 ? { lamport: n(3) } : null),
  });
  file.medications = Array.from({ length: n(2) }, med);
  file.medicationHistory = Array.from({ length: n(2) }, med);
  file.documents = Array.from({ length: n(2) }, (): FileDocument => ({
    id: id(), title: pick(['t1', 't2']), type: 'other' as FileDocument['type'], date: null, fileRef: '', contentHash: '',
    mimeType: '', extractedText: '', addedAt: pick(STAMPS), ...(r() < 0.3 ? { deleted: true } : null),
  }));
  file.profile = {
    updatedAt: pick(STAMPS), lamport: n(3),
    ...(r() < 0.6 ? { heightCm: 160 + n(3) } : null),
    ...(r() < 0.5 ? { sex: pick(['male', 'female'] as const) } : null),
    ...(r() < 0.5 ? { fieldStamps: { heightCm: { updatedAt: pick(STAMPS), lamport: n(3) } } } : null),
  };
  if (r() < 0.4) {
    file.reminderOptIn = {
      updatedAt: pick(STAMPS), lamport: n(2), status: r() < 0.5 ? 'active' : 'cancelled',
      token: 'test-token-good', email: 'a@example.com', provider: 'dropbox',
    };
  }
  return file;
}

const digest = (file: RoadmapFile) => createHash('sha256').update(stableStringify(file) ?? '').digest('hex').slice(0, 16);

describe('US-64 A1-2: mergeFiles on 200 seeded pairs matches the snapshot main wrote', () => {
  it('gives the file main gave, byte for byte, in each order', () => {
    const out: string[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const a = smallFile(r, 'a');
      const b = smallFile(r, 'b');
      const opts = { deviceId: 'dev_merge', now: '2026-05-01T12:00:00Z' };
      out.push(`${seed} ${digest(mergeFiles(a, b, opts))} ${digest(mergeFiles(b, a, opts))}`);
    }
    expect(out).toMatchSnapshot();
  });
});
