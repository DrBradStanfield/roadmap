// US-58 AC3: the engine serves the guides on screenJson's My data, so a
// correction ships over the air (ios/architecture.md D3); bridge.test.ts guards the contract.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screenJson } from './entry';
import { METRIC_GUIDES } from '../../packages/health-core/src/metric-guides';

const NOW = '2026-10-21T08:00:00.000Z';
const sample = readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8');

describe('guides through the screen door (US-58 AC3)', () => {
  const myData = JSON.parse(screenJson(sample, NOW, 'phone', '{}')).myData;

  it('carries every guide, word for word', () => {
    expect(myData.guides).toEqual(METRIC_GUIDES);
  });

  it('has a guide for every metric row My data shows, blood pressure included', () => {
    const rows = [...myData.vitals, ...myData.bloodTests, myData.psa];
    for (const row of rows) expect(myData.guides[row.metric], row.metric).toBeDefined();
    expect(rows.map((r: { metric: string }) => r.metric)).toContain('blood_pressure');
  });

  it('has a guide for every drug question, and none for a dose or escalation answer', () => {
    const keys: string[] = myData.medications.flatMap((s: { groups: Array<{ fields: Array<{ key?: string }> }> }) =>
      s.groups.flatMap((g) => g.fields.map((f) => f.key ?? '')));
    const drugs = keys.filter((k) => !k.endsWith('_dose') && !k.endsWith('_escalation'));
    expect(drugs.length).toBeGreaterThan(0);
    for (const key of drugs) expect(myData.guides[key], key).toBeDefined();
    for (const key of keys.filter((k) => !drugs.includes(k))) expect(myData.guides[key], key).toBeUndefined();
  });

  it('reaches the later drug questions with their guides when the record holds those answers (pcsk9i, bempedoic acid, SGLT2, metformin)', () => {
    const record = JSON.parse(sample);
    const med = (medicationKey: string, drugName: string) => ({
      id: `test-${medicationKey}`, medicationKey, drugName, doseValue: null, doseUnit: null, updatedAt: '2026-08-21T09:00:00Z', lamport: 2,
    });
    record.medications.push(med('pcsk9i', 'yes'), med('bempedoic_acid', 'bempedoic_acid'), med('sglt2i', 'empagliflozin'), med('metformin', 'ir_500'));
    const shown = JSON.parse(screenJson(JSON.stringify(record), NOW, 'phone', '{}')).myData;
    const keys: string[] = shown.medications.flatMap((s: { groups: Array<{ fields: Array<{ key?: string }> }> }) =>
      s.groups.flatMap((g) => g.fields.map((f) => f.key ?? '')));
    for (const key of ['pcsk9i', 'bempedoic_acid', 'sglt2i', 'metformin']) {
      expect(keys, key).toContain(key);
      expect(shown.guides[key], key).toBeDefined();
    }
  });
});
