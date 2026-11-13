// I-2 step 1: contract.ts is the bridge's one source. The checked-in JSON pair is generated
// from it byte for byte, so the bridge id (the hashed file's SHA-256 prefix) is the
// contract's. A contract edit without `npx tsx ios/scripts/gen-contract.ts` fails here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './entry';
import { checkArgs, DOORS, EDIT, type Door } from './contract';
import { parseEdit } from './my-data';
import { bridgeContractJson, bridgeOptionalJson } from './contract-json';

const file = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe('bridge contract source (I-2, US-25 AC18, AC18c)', () => {
  it('generates bridge-contract.json byte for byte, so the bridge id is unchanged', () => {
    expect(bridgeContractJson()).toBe(file('bridge-contract.json'));
    expect(createHash('sha256').update(bridgeContractJson()).digest('hex').slice(0, 16)).toBe('40fc97db4ca12547');
  });

  it('generates bridge-optional.json byte for byte', () => {
    expect(bridgeOptionalJson()).toBe(file('bridge-optional.json'));
  });

  it('names every door entry.ts exports, with entry.ts\'s arity', () => {
    const exported = Object.entries(entry).filter(([, v]) => typeof v === 'function');
    expect(exported.map(([k]) => k).sort()).toEqual(Object.keys(DOORS).sort());
    for (const [name, fn] of exported) {
      const door: Door = DOORS[name as keyof typeof DOORS];
      expect((fn as (...a: unknown[]) => unknown).length, name).toBe(door.args.length + (door.optionalArgs?.length ?? 0));
    }
  });

  // Review R1: kind reaches neither JSON file, so only this holds it. A settle door hands its
  // work to settle(); a promise door answers a Promise; a sync door does neither.
  it('each door\'s kind matches its body', () => {
    const source = ['entry.ts', 'cloud.ts', 'app-doors.ts', 'erase.ts'].map(file).join('\n');
    for (const [name, door] of Object.entries(DOORS) as [string, Door][]) {
      const start = source.search(new RegExp(`export (?:async )?function ${name}\\(`));
      expect(start, name).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n}\n', start));
      const kind = /\breturn settle\(/.test(body) ? 'settle'
        : /^export async function/.test(body) || /\): Promise</.test(body) ? 'promise' : 'sync';
      expect(kind, name).toBe(door.kind);
    }
  });

  it('a door is a contract door or an optional door, and only a contract door carries additions', () => {
    for (const [name, door] of Object.entries(DOORS) as [string, Door][]) {
      if (door.optionalDoor) expect(door.optionalAt ?? door.optionalArgs ?? door.optionalReturns, name).toBeUndefined();
      expect(door.optionalAt === undefined, name).toBe(door.optionalArgs === undefined && door.optionalReturns === undefined);
    }
  });

  // Review R3 of PR 1519: a clash would show as a JSON diff, not as its cause.
  it('the optional additions\' places are 0 to n-1, each once', () => {
    const places = (Object.values(DOORS) as Door[]).flatMap((door) => (door.optionalAt === undefined ? [] : [door.optionalAt]));
    expect(places.sort((a, b) => a - b)).toEqual(places.map((_, at) => at));
  });
});

// I-2 step 2: every door reads its arguments with the contract's types where they enter.
describe('US-25 AC18c: doors parse their arguments (I-2 step 2)', () => {
  it('every door\'s first line checks its arguments against the contract', () => {
    const source = ['entry.ts', 'cloud.ts', 'app-doors.ts', 'erase.ts'].map(file).join('\n');
    for (const name of Object.keys(DOORS)) {
      const start = source.search(new RegExp(`export (?:async )?function ${name}\\(`));
      expect(start, name).toBeGreaterThan(-1);
      const body = source.slice(source.indexOf('{\n', start) + 2);
      expect(body.trimStart().startsWith(`checkArgs('${name}', arguments);`), name).toBe(true);
    }
  });

  it('a call of the wrong type is refused by name, never echoing the value', () => {
    const door = entry as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(() => door.planJson(42, '2026-10-21T08:00:00.000Z', 'phone')).toThrow(new TypeError("planJson: recordJson is not the contract's type"));
    expect(() => door.numberJson(null)).toThrow('numberJson: text');
    expect(() => door.convertJson('weight', 'secret-80', 'si', 'conventional')).toThrow(/^convertJson: value is not the contract's type$/);
    expect(() => checkArgs('cloudOpen', ['dropbox', 'phone', true, 'yes'])).toThrow('cloudOpen: mergePhone');
    expect(() => checkArgs('cloudOpen', ['icloud', 'phone', true, false])).toThrow('cloudOpen: provider');
  });

  it('an optional argument may be left out; a contract one may not', () => {
    expect(() => checkArgs('screenJson', ['{}', 'now', 'phone'])).not.toThrow();
    expect(() => checkArgs('screenJson', ['{}', 'now', 'phone', '{}', true])).not.toThrow();
    expect(() => checkArgs('screenJson', ['{}', 'now'])).toThrow('screenJson: deviceId');
    expect(() => checkArgs('documentSave', ['{}', '{}', '{}', null, 'e', 'now', 'phone'])).not.toThrow();
    expect(() => checkArgs('documentSave', ['{}', '{}', '{}', new ArrayBuffer(1), 'e', 'now', 'phone'])).not.toThrow();
    expect(() => checkArgs('documentSave', ['{}', '{}', '{}', new Uint8Array(1), 'e', 'now', 'phone'])).toThrow('documentSave: original');
  });
});

// The app's edits, each kind as RecordEdit.encode (MyData.swift, FormModels.swift) and the
// engine's own chat Undo write them. All of them read; a malformed one is refused, not cast.
const SWIFT_EDITS: unknown[] = [
  { kind: 'profile', sex: 'female', birthYear: 1970, birthMonth: 6, height: 178 },
  { kind: 'profile', heightFeet: 5, heightInches: 10 },
  { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20', replace: false },
  { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20', replace: true, seenIds: ['a', 'b'] },
  { kind: 'units', unitSystem: 'conventional' },
  { kind: 'alcohol', alcohol: null },
  { kind: 'alcohol', alcohol: 'drinks' },
  { kind: 'lpaUnit', unit: 'mg/dL' },
  { kind: 'add', metric: 'weight', value: 80.5, day: '2026-10-20' },
  { kind: 'correct', id: 'row-1', value: 81 },
  { kind: 'labAdd', series: 'ferritin', value: 85, day: '2026-10-20', unit: 'µg/L' },
  { kind: 'labAddName', name: 'Ferritin', value: 85, day: '2026-10-20', unit: 'µg/L' },
  { kind: 'appleHealth', samples: [{ externalId: 'u-1', metricType: 'weight', value: 80, measuredAt: '2026-10-21T08:30:00+13:00' },
    { externalId: 'u-2', metricType: 'systolic_bp', value: 120, measuredAt: '2026-10-21T08:30:00+13:00', pairId: 'p-1' }] },
  { kind: 'healthRecords', records: [{ sourceId: 's', resourceType: 'Observation', fhirVersion: '4.0.1', json: '{}' }] },
  { kind: 'medicationField', field: 'statin', value: 'none' },
  { kind: 'screening', key: 'colorectalMethod', value: '' },
  { kind: 'supplement', supplementKey: 'creatine', supplementName: 'Creatine', doseValue: null, doseUnit: null, status: 'active' },
  { kind: 'customSupplement', name: 'Magnesium' },
  { kind: 'labImport', extractionJson: '{}', refs: ['v0'], reportDay: '2026-10-20' },
  { kind: 'chatEdits', part: 'review', edits: [{ kind: 'field', field: 'ldlC' }], today: '2026-10-21' },
  { kind: 'chatEdits', part: 'review', edits: [], today: '2026-10-21', seen: [['ldlC', null]] },
  { kind: 'chatUndo', medications: [{ medicationKey: 'statin', drugName: 'none', doseValue: null, doseUnit: null }] },
  { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
];

describe('US-25 AC18c: the Edit the app sends (I-2 step 2)', () => {
  it('reads every kind the app and the engine write, unchanged', () => {
    for (const edit of SWIFT_EDITS) expect(parseEdit(JSON.stringify(edit)), JSON.stringify(edit)).toEqual({ ok: true, edit });
  });

  it('names every kind of the contract\'s Edit', () => {
    const kinds = new Set(SWIFT_EDITS.map((edit) => (edit as { kind: string }).kind));
    expect([...kinds].sort()).toEqual(EDIT.options.map((option) => option.shape.kind.value).sort());
  });

  it('refuses an edit that is not JSON, names no kind, or has a field of the wrong type', () => {
    const refused = { ok: false, reason: 'invalid-edit', message: 'This change could not be read, so it was not saved.' };
    for (const text of ['not json', '[]', 'null', '{"kind":"delete"}', '{"kind":"add","metric":"weight","value":"80"}',
      '{"kind":"correct","id":7,"value":81}', '{"kind":"appleHealth","samples":"nope"}', '{"kind":"bloodPressure","systolic":120,"day":"2026-10-20"}']) {
      expect(parseEdit(text), text).toEqual(refused);
    }
  });

  it('applyEditJson and cloudEdit answer a malformed edit with the refusal, writing nothing', () => {
    const record = entry.newRecordJson('2026-10-21T08:00:00.000Z', 'phone', 'en-NZ', 'Pacific/Auckland');
    expect(JSON.parse(entry.applyEditJson(record, '{"kind":"add","metric":"weight"}', '2026-10-21T08:00:00.000Z', 'phone')))
      .toEqual({ ok: false, reason: 'invalid-edit', message: 'This change could not be read, so it was not saved.' });
    expect(JSON.parse(entry.cloudEdit('{"kind":"add","metric":"weight"}', 'e', 'si', '2026-10-21T08:00:00.000Z')))
      .toEqual({ ok: false, reason: 'invalid-edit', message: 'This change could not be read, so it was not saved.' });
  });
});
