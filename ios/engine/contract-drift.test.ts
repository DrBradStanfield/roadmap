// I-2 step 3 (US-25 AC18c): every platform has picked up the contract. CI runs this on every
// push: a contract edit without `npx tsx ios/scripts/gen-contract.ts` fails here, and so does
// hand-written Swift that reaches a door any way but its generated method.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './entry';
import { CONVERSION, DOORS, EDIT_OUTCOME } from './contract';
import { contractHash, generatedFiles } from './contract-swift';

const ios = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ios, path), 'utf8');

/** Every Swift file under `dir`, by its path under ios/. */
function swiftFiles(dir: string): string[] {
  return readdirSync(join(ios, dir), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.swift')).map((path) => join(dir, path));
}

describe('US-25 AC18c: the generated files match the contract (I-2 step 3)', () => {
  it('every generated file is checked in byte for byte', () => {
    for (const [path, text] of Object.entries(generatedFiles())) expect(read(path), path).toBe(text);
  });

  it('each generated Swift file carries the contract\'s hash, and the app serves it', () => {
    const hash = contractHash();
    for (const path of ['HealthRoadmap/Engine/Generated/EngineContract.swift', 'HealthRoadmap/Engine/Generated/EngineDoors.swift']) {
      expect(read(path).match(/^\/\/ contractHash: (\w+)$/m)?.[1], path).toBe(hash);
    }
    expect(read('HealthRoadmap/Engine/Generated/EngineContract.swift')).toContain(`static let contractHash = "${hash}"`);
  });

  // Review R2 of PR 1558: any quoted door name, not only a call on one line, so a call split over
  // lines or a name held in a variable is caught too. Door names are rare words.
  const named = new RegExp(`"(?:${Object.keys(DOORS).join('|')})"`);

  it('hand-written app code reaches a door only through its generated method', () => {
    const offenders = swiftFiles('HealthRoadmap')
      .filter((path) => !path.startsWith(join('HealthRoadmap', 'Engine', 'Generated')))
      .flatMap((path) => read(path).split('\n').filter((line) => named.test(line)).map((line) => `${relative(ios, join(ios, path))}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('the check catches a door named outside its generated method', () => {
    expect(named.test('let json = try call("planJson", [record])')).toBe(true);
    expect(named.test('let door = "chatDeleteJson"')).toBe(true);
    expect(named.test('try doorPlanJson(recordJson: record, nowIso: now, deviceId: id, unitsJson: units)')).toBe(false);
  });

  // Review R1 of PR 1558: a Swift body of more than one statement needs `return`; the byte check
  // alone passed a generator that left it out, and nothing here compiles Swift.
  it('every generated door method with argument lines returns its answer', () => {
    const methods = read('HealthRoadmap/Engine/Generated/EngineDoors.swift').split('\n    func ').slice(1);
    expect(methods.length).toBeGreaterThan(Object.keys(DOORS).length - 1);
    for (const method of methods) {
      const body = method.slice(method.indexOf('{\n') + 2, method.indexOf('\n    }')).split('\n');
      if (body.length > 1) expect(body.at(-1)!.trim().startsWith('return '), method.slice(0, 40)).toBe(true);
    }
  });
});

describe('US-25 AC18c: a typed answer holds its contract shape (I-2 step 3)', () => {
  const NOW = '2026-10-21T08:00:00.000Z';
  it('applyEditJson and cloudEdit answer an EditOutcome; convertJson a UnitConversion', () => {
    const record = entry.newRecordJson(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const saved = JSON.parse(entry.applyEditJson(record, JSON.stringify({ kind: 'add', metric: 'weight', value: 80, day: '2026-10-20' }), NOW, 'phone'));
    expect(EDIT_OUTCOME.parse(saved)).toMatchObject({ ok: true });
    const refused = JSON.parse(entry.applyEditJson(record, JSON.stringify({ kind: 'add', metric: 'systolic_bp', value: 400, day: '2026-10-20' }), NOW, 'phone'));
    expect(EDIT_OUTCOME.parse(refused)).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(EDIT_OUTCOME.parse(JSON.parse(entry.cloudEdit('{"kind":"units","unitSystem":"si"}', 'e', 'si', NOW)))).toMatchObject({ ok: false, reason: 'not-open' });
    expect(CONVERSION.parse(JSON.parse(entry.convertJson('height', 178, 'si', 'conventional')))).toMatchObject({ feetInches: { feet: 5, inches: 10 } });
    expect(CONVERSION.parse(JSON.parse(entry.convertJson('weight', 80, 'si', 'conventional')))).toMatchObject({ feetInches: null });
  });
});
