// Codex R3 (US-25 AC18, US-52 AC5): the app sends only an allow-list of the chat
// context's top-level keys (ChatClient.contextKeys in Swift). This test fails if
// health-core's chatContextOf can produce a key the list lacks, or the list names one
// it cannot produce, so the allow-list never silently drops real data or lets extra through.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parityFixtures } from './fixtures.mjs';
import { chatContextJson } from './app-doors';
import { buildChatContextJson } from '../../packages/health-core/src/chat-context';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const swift = readFileSync(join(__dirname, '../HealthRoadmap/Chat/ChatClient.swift'), 'utf8');
const block = swift.slice(swift.indexOf('static let contextKeys'), swift.indexOf(']', swift.indexOf('static let contextKeys')));
const allowed = new Set([...block.matchAll(/"(\w+)"/g)].map((m) => m[1]));

/** HealthInputs' fields, read from types.ts, plus chatContextOf's own four keys. */
function producible(): Set<string> {
  const types = readFileSync(join(__dirname, '../../packages/health-core/src/types.ts'), 'utf8');
  const body = types.slice(types.indexOf('export interface HealthInputs {'));
  const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  const chat = readFileSync(join(__dirname, '../../packages/health-core/src/chat-context.ts'), 'utf8');
  const own = chat.slice(chat.indexOf('export type ChatContextPayload'));
  const extras = [...own.slice(0, own.indexOf('};')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  return new Set([...fields, ...extras]);
}

describe('chat context allow-list (Codex R3)', () => {
  it('is exactly the keys chatContextOf can produce', () => {
    expect(allowed.size).toBe(26);
    expect([...allowed].sort()).toEqual([...producible()].sort());
  });

  it('covers every key the engine sends for the parity records', () => {
    const sample = JSON.parse(readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'));
    for (const [name, record] of Object.entries(parityFixtures(sample))) {
      const keys = Object.keys(JSON.parse(chatContextJson(JSON.stringify(record), '2026-10-21T12:30:00.000Z', 'ios-test')));
      expect(keys.filter((key) => !allowed.has(key)), name).toEqual([]);
    }
  });
});

// Codex R1 on PR 402 (US-07 AC8): a binary forwards only its own allow-list, so an engine
// that produces a key an older binary lacks must not reach it. The bridge id is what keeps
// an engine from an app (D3): it moves with the contract, and an app reads only its own
// bridge's releases. These are the last binary's bridge and allow-list, before limits
// (US-12 AC20): build 5 carries 8dee92d80c028ed3 (main's id before the 2026-11-02 move).
describe('an older binary never takes an engine whose chat context it would strip', () => {
  const PREVIOUS = {
    bridge: '8dee92d80c028ed3',
    keys: [
      'heightCm', 'weightKg', 'waistCm', 'sex', 'birthYear', 'birthMonth',
      'hba1c', 'ldlC', 'totalCholesterol', 'hdlC', 'triglycerides', 'apoB', 'creatinine', 'psa', 'lpa',
      'systolicBp', 'diastolicBp', 'labEgfr', 'labEgfrDate', 'labEgfrOutdated', 'unitSystem', 'alcohol',
      'medications', 'screenings', 'measurementHistory',
    ],
  };
  const bridge = createHash('sha256').update(readFileSync(join(__dirname, 'bridge-contract.json'))).digest('hex').slice(0, 16);

  it('the engine produces a key the previous binary strips, so the bridge id has moved', () => {
    const stripped = [...producible()].filter((key) => !PREVIOUS.keys.includes(key));
    expect(stripped).toEqual(['limits']);
    expect(bridge).not.toBe(PREVIOUS.bridge);
  });

  it('the contract names the key and the rule, and Swift serves the new bridge', () => {
    const contract = JSON.parse(readFileSync(join(__dirname, 'bridge-contract.json'), 'utf8'));
    expect(contract.doors.chatContextJson.returns).toContain('labEgfrOutdated');
    expect(contract.doors.chatContextJson.returns).toContain('limits');
    expect(contract.doors.chatContextJson.returns).toContain('must not run this engine');
    const release = readFileSync(join(__dirname, '../HealthRoadmap/Engine/Generated/EngineContract.swift'), 'utf8'); // generated since I-2 step 3
    expect(release).toContain(`static let bridge = "${bridge}"`);
  });
});

// US-06 AC21 item 6 (Brad 2026-11-13): `raisedBefore` rides on the newest point inside
// measurementHistory, never as a top-level key, so the allow-list above (top-level keys
// only) forwards it whole, and an older binary does too: the bridge need not move.
describe('the PSA point\'s raisedBefore leaves the phone inside measurementHistory', () => {
  it('raised, then 25 vague results: the engine sets it, the allow-list keeps it, the server gives "Repeat PSA test"', () => {
    const at = '2026-10-21T12:30:00.000Z';
    const f = createEmptyFile({ deviceId: 'ios-test', now: at });
    const days = ['2024-06-01', ...Array.from({ length: 25 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + 7 * i)).toISOString().slice(0, 10))];
    const file: RoadmapFile = {
      ...f,
      profile: { ...f.profile, sex: 'male', heightCm: 178, weightKg: 80, birthYear: 1962, birthMonth: 1 } as RoadmapFile['profile'],
      screenings: { ...f.screenings, prostateDiscussion: 'elected_not_to' } as RoadmapFile['screenings'],
      measurements: days.map((day, i) => createMeasurement({
        id: `p${i}`, metricType: 'psa', value: i === 0 ? 4.5 : 5, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`,
        ...(i > 0 && { comparator: '<' as const }),
      })),
    };
    const context = JSON.parse(chatContextJson(JSON.stringify(file), at, 'ios-test'));
    const sent = Object.fromEntries(Object.entries(context).filter(([key]) => allowed.has(key)));
    const series = (sent.measurementHistory as { psa: Array<Record<string, unknown>> }).psa;
    expect(series.at(-1)).toEqual({ date: days.at(-1), value: 5, comparator: '<', raisedBefore: true });
    expect(JSON.stringify(sent)).not.toContain('2024-06-01');
    const ids = (JSON.parse(buildChatContextJson(sent)!).currentSuggestions as Array<{ id: string }>).map((s) => s.id);
    expect(ids.filter((id) => id.startsWith('screening-prostate'))).toEqual(['screening-prostate-repeat']);
  });
});
