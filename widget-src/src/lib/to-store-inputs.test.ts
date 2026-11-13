import { describe, it, expect } from 'vitest';
import { toStoreInputs } from './to-store-inputs';
import type { ReviewDecisions } from './upload-pipeline';

type In = Pick<ReviewDecisions, 'values' | 'labValues'>;
const AT = '2024-03-05T12:00:00.000Z';
const value = (extra: Partial<In['values'][number]> = {}): In['values'][number] =>
  ({ metric: 'ldl', valueSI: 3.1, recordedAt: AT, ...extra });
const lab = (extra: Partial<In['labValues'][number]> = {}): In['labValues'][number] =>
  ({ name: 'Ferritin', value: 85, unit: 'ug/L', referenceLow: 30, referenceHigh: 400, recordedAt: AT, ...extra });

// US-12: the reviewed rows become the store's bulk inputs (lead W2-18).
describe('toStoreInputs (US-12)', () => {
  const cases: Array<{ name: string; input: In; measurements: unknown[]; labValues: unknown[] }> = [
    { name: 'an empty review saves nothing', input: { values: [], labValues: [] }, measurements: [], labValues: [] },
    {
      name: 'a measurement row: metric and SI value renamed, the date kept, the source defaulted',
      input: { values: [value()], labValues: [] },
      measurements: [{ metricType: 'ldl', value: 3.1, recordedAt: AT, source: 'lab_import', correctsId: undefined }],
      labValues: [],
    },
    {
      name: 'an edited measurement keeps its edited source',
      input: { values: [value({ source: 'lab_import_edited' })], labValues: [] },
      measurements: [{ metricType: 'ldl', value: 3.1, recordedAt: AT, source: 'lab_import_edited', correctsId: undefined }],
      labValues: [],
    },
    {
      name: 'a ticked Replace carries correctsId',
      input: { values: [value({ correctsId: 'row-1' })], labValues: [lab({ correctsId: 'row-2' })] },
      measurements: [{ metricType: 'ldl', value: 3.1, recordedAt: AT, source: 'lab_import', correctsId: 'row-1' }],
      labValues: [{ metricName: 'Ferritin', value: 85, unit: 'ug/L', referenceLow: 30, referenceHigh: 400, recordedAt: AT, source: 'lab_import', correctsId: 'row-2' }],
    },
    {
      name: 'a lab row: printed name and unit kept, null ranges kept, source always lab_import',
      input: { values: [], labValues: [lab({ unit: 'mmol/L', referenceLow: null, referenceHigh: null })] },
      measurements: [],
      labValues: [{ metricName: 'Ferritin', value: 85, unit: 'mmol/L', referenceLow: null, referenceHigh: null, recordedAt: AT, source: 'lab_import', correctsId: undefined }],
    },
    {
      name: 'a printed limit keeps its comparator',
      input: { values: [value({ comparator: '>' })], labValues: [lab({ comparator: '<=' })] },
      measurements: [{ metricType: 'ldl', value: 3.1, recordedAt: AT, source: 'lab_import', correctsId: undefined, comparator: '>' }],
      labValues: [{ metricName: 'Ferritin', value: 85, unit: 'ug/L', referenceLow: 30, referenceHigh: 400, recordedAt: AT, source: 'lab_import', correctsId: undefined, comparator: '<=' }],
    },
    {
      name: 'the comparatorOf guard drops a string that is not one of the four codes',
      input: { values: [value({ comparator: 'gt' as never })], labValues: [lab({ comparator: 'about' as never })] },
      measurements: [{ metricType: 'ldl', value: 3.1, recordedAt: AT, source: 'lab_import', correctsId: undefined }],
      labValues: [{ metricName: 'Ferritin', value: 85, unit: 'ug/L', referenceLow: 30, referenceHigh: 400, recordedAt: AT, source: 'lab_import', correctsId: undefined }],
    },
    {
      name: 'a measurement and a lab row map side by side, each in its own shape and order',
      input: { values: [value(), value({ metric: 'hba1c', valueSI: 41, recordedAt: '2024-01-02T12:00:00.000Z' })], labValues: [lab()] },
      measurements: [
        { metricType: 'ldl', value: 3.1, recordedAt: AT, source: 'lab_import', correctsId: undefined },
        { metricType: 'hba1c', value: 41, recordedAt: '2024-01-02T12:00:00.000Z', source: 'lab_import', correctsId: undefined },
      ],
      labValues: [{ metricName: 'Ferritin', value: 85, unit: 'ug/L', referenceLow: 30, referenceHigh: 400, recordedAt: AT, source: 'lab_import', correctsId: undefined }],
    },
  ];

  it.each(cases)('$name', ({ input, measurements, labValues }) => {
    const out = toStoreInputs(input);
    expect(out.measurements).toStrictEqual(measurements);
    expect(out.labValues).toStrictEqual(labValues);
  });

  it('keeps the key order the UploadModal pins snapshot (source between recordedAt and correctsId)', () => {
    const out = toStoreInputs({ values: [value({ correctsId: 'a', comparator: '<' })], labValues: [lab({ correctsId: 'b', comparator: '>=' })] });
    expect(Object.keys(out.measurements[0])).toEqual(['metricType', 'value', 'recordedAt', 'source', 'correctsId', 'comparator']);
    expect(Object.keys(out.labValues[0])).toEqual(['metricName', 'value', 'unit', 'referenceLow', 'referenceHigh', 'recordedAt', 'source', 'correctsId', 'comparator']);
  });
});
