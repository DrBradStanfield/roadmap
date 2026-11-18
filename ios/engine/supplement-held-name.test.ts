// US-06 AC1d: the iPhone changes the dose of, stops and restarts a supplement
// the web form saved, whatever characters its stored name holds.
import { describe, expect, it } from 'vitest';
import { applyEdit, newRecord } from './my-data';
import { applyEditJson } from './entry';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { customSupplementAdd } from '../../packages/health-core/src/input-form';
import { upsertSupplement } from '../../packages/health-core/src/state-edits';

const NOW = '2026-10-21T08:00:00.000Z';
const LATER = '2026-10-21T09:00:00.000Z';
const REFUSED = { ok: false, reason: 'invalid-value', message: 'Supplement name contains invalid characters' };

/** A record holding one supplement added as the web form adds it: no check on the name's characters. */
function webAdded(name: string): RoadmapFile {
  const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
  return upsertSupplement(file, { ...customSupplementAdd(name, file.supplements), doseValue: null, doseUnit: null, status: 'active' }, NOW).file;
}

/** The edit the app sends for a row it shows (FormModels.swift): the stored key and name. */
function rowEdit(file: RoadmapFile, change: { doseValue?: number | null; doseUnit?: string | null; status?: string }) {
  const { supplementKey, supplementName } = file.supplements[0];
  return { kind: 'supplement' as const, supplementKey, supplementName, doseValue: null, doseUnit: null, status: 'active', ...change };
}

function applied(file: RoadmapFile, edit: Parameters<typeof applyEdit>[1], now = LATER): RoadmapFile {
  const outcome = applyEdit(file, edit, now);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.file;
}

// Each holds a character the phone's name pattern refuses: &, an accent, a colon, %, a curly apostrophe, non-Latin letters.
const WEB_NAMES = ['D3 & K2', 'Créatine', 'Omega-3: EPA', 'Zinc 50%', 'St John’s wort', '維他命'];

describe('a supplement the web saved under a name the phone would not take (US-06 AC1d)', () => {
  it.each(WEB_NAMES)('takes a dose on the phone: %s', (name) => {
    const file = webAdded(name);
    const row = file.supplements[0];
    const dosed = applied(file, rowEdit(file, { doseValue: 2, doseUnit: 'mg' }));
    expect(dosed.supplements).toHaveLength(1);
    expect(dosed.supplements[0]).toMatchObject({ id: row.id, supplementKey: row.supplementKey, supplementName: name, doseValue: 2, doseUnit: 'mg', status: 'active' });
    expect(dosed.supplementHistory.at(-1)).toMatchObject({ supplementKey: row.supplementKey, supplementName: name, changeType: 'dose_changed' });
  });

  it.each(WEB_NAMES)('stops on the phone, and starts again when its name is typed there: %s', (name) => {
    const file = webAdded(name);
    const row = file.supplements[0];
    const stopped = applied(file, rowEdit(file, { status: 'stopped' }));
    expect(stopped.supplements[0]).toMatchObject({ id: row.id, supplementName: name, status: 'stopped' });
    // Typed in another case: the stored row and its spelling are kept (AC1a).
    const restarted = applied(stopped, { kind: 'customSupplement', name: name.toUpperCase() }, '2026-10-21T10:00:00.000Z');
    expect(restarted.supplements).toHaveLength(1);
    expect(restarted.supplements[0]).toMatchObject({ id: row.id, supplementKey: row.supplementKey, supplementName: name, status: 'active' });
  });

  it('saves the dose through the app\'s JSON door', () => {
    const file = webAdded('D3 & K2');
    const answer = JSON.parse(applyEditJson(JSON.stringify(file), JSON.stringify(rowEdit(file, { doseValue: 2, doseUnit: 'mg' })), LATER, 'phone'));
    expect(answer.ok).toBe(true);
    expect(JSON.parse(answer.record).supplements[0]).toMatchObject({ supplementName: 'D3 & K2', doseValue: 2 });
  });

  it('still checks the rest of the edit: the dose and the status', () => {
    const file = webAdded('D3 & K2');
    expect(applyEdit(file, rowEdit(file, { doseValue: -1 }), LATER)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(applyEdit(file, rowEdit(file, { status: 'paused' }), LATER)).toMatchObject({ ok: false, reason: 'invalid-value' });
    expect(applyEdit(file, rowEdit(file, { doseUnit: 'x'.repeat(21) }), LATER)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });
});

describe('what the phone still refuses (US-06 AC1d)', () => {
  it('a new supplement typed on the phone with such a name', () => {
    const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(applyEdit(file, { kind: 'customSupplement', name: 'D3 & K2' }, LATER)).toEqual(REFUSED);
    expect(applyEdit(file, { kind: 'supplement', supplementKey: 'custom_d3_k2', supplementName: 'D3 & K2', status: 'active' }, LATER)).toEqual(REFUSED);
  });

  it('another name the pattern refuses, sent for a key the record holds', () => {
    const file = webAdded('D3 & K2');
    expect(applyEdit(file, { ...rowEdit(file, {}), supplementName: 'D3 & K2 & A' }, LATER)).toEqual(REFUSED);
    // Not a match in another case or with spaces around it: only the stored name itself passes.
    expect(applyEdit(file, { ...rowEdit(file, {}), supplementName: 'd3 & k2' }, LATER)).toEqual(REFUSED);
    expect(applyEdit(file, { ...rowEdit(file, {}), supplementName: ' D3 & K2' }, LATER)).toEqual(REFUSED);
    const plain = webAdded('Taurine');
    expect(applyEdit(plain, { ...rowEdit(plain, {}), supplementName: 'Taurine & more' }, LATER)).toEqual(REFUSED);
    expect(applyEdit(plain, { ...rowEdit(plain, {}), supplementName: '' }, LATER)).toMatchObject({ ok: false, reason: 'invalid-value' });
  });

  it('the stored name of one row sent under another row\'s key', () => {
    let file = webAdded('D3 & K2');
    file = upsertSupplement(file, { ...customSupplementAdd('Taurine', file.supplements), doseValue: null, doseUnit: null, status: 'active' }, NOW).file;
    const taurine = file.supplements.find((row) => row.supplementName === 'Taurine')!;
    expect(applyEdit(file, { kind: 'supplement', supplementKey: taurine.supplementKey, supplementName: 'D3 & K2', status: 'active' }, LATER)).toEqual(REFUSED);
  });
});

describe('unchanged for a name the pattern takes (US-06 AC1d)', () => {
  it('a dose, a stop and a new name within the pattern save as before', () => {
    const file = webAdded('Taurine');
    const row = file.supplements[0];
    expect(applied(file, rowEdit(file, { doseValue: 3, doseUnit: 'g' })).supplements[0]).toMatchObject({ id: row.id, supplementName: 'Taurine', doseValue: 3 });
    expect(applied(file, rowEdit(file, { status: 'stopped' })).supplements[0]).toMatchObject({ id: row.id, status: 'stopped' });
    expect(applied(file, { ...rowEdit(file, {}), supplementName: 'Taurine (powder)' }).supplements[0]).toMatchObject({ id: row.id, supplementName: 'Taurine (powder)' });
  });

  it('the pattern still takes its own punctuation in a new name typed on the phone: -+().,\'/', () => {
    const name = "A-b+c (d). e, f'g/h 1";
    expect(applied(newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), { kind: 'customSupplement', name }).supplements[0]).toMatchObject({ supplementName: name, status: 'active' });
  });
});
