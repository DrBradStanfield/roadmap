// US-25 AC25, US-21: the one lab add both apps use (record-edits.ts addLabValue): the web's
// "+ Add a value" (AddLabTest.tsx) and the iPhone's lab page. Synthetic values.
import { describe, expect, it } from 'vitest';
import { addLabValue } from './record-edits';
import { createEmptyFile, type FileLabValue, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const held = (id: string, metricName: string, value: number, unit: string, day: string): FileLabValue => ({
  id, metricName, value, unit, referenceLow: null, referenceHigh: null, recordedAt: `${day}T00:00:00.000Z`, createdAt: NOW,
  source: 'lab_import', status: 'active', correctsId: null,
});
const record = (labValues: FileLabValue[]): RoadmapFile => ({ ...createEmptyFile({ deviceId: 'd', now: NOW }), labValues });

describe('addLabValue (US-25 AC25)', () => {
  it('files a catalogued test in its catalogue unit under the catalogue key; any other under the name and unit given', () => {
    const exact = addLabValue(record([]), { metricName: 'Ferritin', unit: 'ng/mL', value: 90, day: '2026-10-01' }, NOW);
    if (!exact.ok) throw new Error(exact.message);
    expect(exact.row).toMatchObject({ metricName: 'ferritin', unit: 'µg/L', value: 90, source: 'manual', status: 'active', correctsId: null });
    const converted = addLabValue(record([]), { metricName: 'Vitamin D', unit: 'ng/mL', value: 32, day: '2026-10-01' }, NOW);
    if (!converted.ok) throw new Error(converted.message);
    expect(converted.row).toMatchObject({ metricName: 'Vitamin D', unit: 'nmol/L' });
    const custom = addLabValue(record([]), { metricName: 'Zinc custom', unit: 'µg/dL', value: 80, day: '2026-10-01' }, NOW);
    if (!custom.ok) throw new Error(custom.message);
    expect(custom.row).toMatchObject({ metricName: 'Zinc custom', unit: 'µg/dL' });
  });

  it('refuses a taken day, offering the held row only when it is another number in the same unit (sameLabQuantity)', () => {
    const file = record([held('f1', 'ferritin', 80, 'µg/L', '2026-10-01')]);
    expect(addLabValue(file, { metricName: 'ferritin', unit: 'µg/L', value: 85, day: '2026-10-01' }, NOW))
      .toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/L for that date.', existingId: 'f1' });
    expect(addLabValue(file, { metricName: 'ferritin', unit: 'µg/L', value: 80, day: '2026-10-01' }, NOW))
      .toEqual({ ok: false, reason: 'slot-occupied', message: 'That test already has 80 µg/L for that date.' });
  });

  it('refuses a negative number, a future day, no name and a unit the catalogue does not take', () => {
    expect(addLabValue(record([]), { metricName: 'ferritin', unit: 'µg/L', value: -1, day: '2026-10-01' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(addLabValue(record([]), { metricName: 'ferritin', unit: 'µg/L', value: 1, day: '2026-10-30' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-date' });
    expect(addLabValue(record([]), { metricName: ' ', unit: 'µg/L', value: 1, day: '2026-10-01' }, NOW)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(addLabValue(record([]), { metricName: 'ferritin', unit: 'mg/dL', value: 1, day: '2026-10-01' }, NOW))
      .toMatchObject({ ok: false, reason: 'unknown-unit', message: expect.stringMatching(/^Ferritin: unit not recognised \(mg\/dL\)/) });
  });
});
