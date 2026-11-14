// US-25 AC18: the engine side of the native bridge matches its checked-in
// contract (bridge-contract.json). The contract's hash is the bridge id a
// downloaded engine must match, so drift here would let an engine reach an app
// that cannot serve it. The Swift side: EngineBridgeContractTests.swift.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './entry';

const contract = JSON.parse(readFileSync(join(__dirname, 'bridge-contract.json'), 'utf8')) as {
  natives: Record<string, string>;
  events: string[];
  values: Record<string, string>;
  doors: Record<string, { args: string[]; returns?: string }>;
};
// Both-way additions that keep the bridge id (D14): never hashed.
const optional = JSON.parse(readFileSync(join(__dirname, 'bridge-optional.json'), 'utf8')) as {
  doors: Record<string, { optionalArgs?: string[]; optionalReturns?: string }>;
  optionalDoors: Record<string, { args: string[]; returns: string }>;
};
const optionalArgs = (name: string) => optional.doors[name]?.optionalArgs ?? [];
const arity = (name: string) => (optional.optionalDoors[name]?.args.length ?? contract.doors[name].args.length + optionalArgs(name).length);

/** A door's parameter names, in order, read from entry.ts's signature. */
function parameters(name: string): string[] {
  const source = readFileSync(join(__dirname, 'entry.ts'), 'utf8');
  const signature = source.match(new RegExp(`export (?:async )?function ${name}\\(([^)]*)\\)`))?.[1];
  if (signature === undefined) throw new Error(`no signature for ${name} in entry.ts`);
  return [...signature.matchAll(/(?:^|,)\s*(\w+)\??\s*:/g)].map((m) => m[1]);
}

/** Contract arguments to call each optional door with (one entry per door in bridge-optional.json). */
const NOW = '2026-10-21T08:00:00.000Z';
const SAMPLE_ARGS: Record<string, unknown[]> = {
  screenJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'), NOW, 'phone', '{}'],
  chatEditsJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'),
    JSON.stringify([{ kind: 'field', field: 'ldlC', displayValue: 3.4, unitSystem: 'si', date: '2026-10-01' }]), NOW, 'phone', '2026-10-21', '{}'],
  historyJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'), 'ldl', NOW, 'phone', '{}'],
  remindersJson: [readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'), NOW, 'phone'],
};
/** A door's answer with its timing fields (`ms`) left out, which differ call to call. */
const untimed = (text: string) => JSON.stringify(JSON.parse(text, (key, value) => (key === 'ms' ? undefined : value)));

/** The member names of an exported interface, read from the source. */
function members(file: string, name: string): string[] {
  const source = readFileSync(join(__dirname, file), 'utf8');
  const body = source.slice(source.indexOf(`export interface ${name} {`));
  const block = body.slice(0, body.indexOf('\n}\n'));
  return [...block.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
}

describe('bridge contract (US-25 AC18)', () => {
  it('every door the engine exports is in the contract or is an optional door, never both, with its arity', () => {
    const doors = Object.entries(entry).filter(([, v]) => typeof v === 'function');
    const listed = [...Object.keys(contract.doors), ...Object.keys(optional.optionalDoors)];
    expect(doors.map(([k]) => k).sort()).toEqual(listed.sort());
    expect(new Set(listed).size, 'a door in both').toBe(listed.length);
    for (const [name, fn] of doors) expect((fn as (...a: unknown[]) => unknown).length, name).toBe(arity(name));
  });

  // 2026-11-05 (orchestrator): an optional door keeps the bridge id. An old app never calls it; a
  // new app reaches it only through optionalCall, whose nil for a missing door is the safety.
  it('an optional door names its arguments in entry.ts, says what it answers, and is nowhere in the contract', () => {
    for (const [name, door] of Object.entries(optional.optionalDoors)) {
      expect(parameters(name), name).toEqual(door.args);
      expect(door.returns, name).toBeTruthy();
      expect(readFileSync(join(__dirname, 'bridge-contract.json'), 'utf8'), name).not.toContain(name);
    }
  });

  // Append-only: a shipped app decodes each optional door's answer. A door or a field may be added
  // here; none is ever renamed, retyped or dropped, and a door's arguments never change.
  // `bytes`: a door answering a Promise of an ArrayBuffer, not JSON. With no cloud open here it
  // rejects; its bytes answer is pinned in cloud.test.ts (US-73 AC12).
  // `words`: a door answering a Promise of one bare word, never JSON (S50b).
  const FROZEN_OPTIONAL_DOORS: Record<string, { args: string[]; call: unknown[]; shape?: unknown; bytes?: true; words?: string[] }> = {
    labSearchJson: { args: ['text'], call: ['ferr'], shape: [{ name: 'string', key: 'string', kind: 'string', units: ['string'] }] },
    documentOriginal: { args: ['id'], call: ['doc-1'], bytes: true },
    cloudOnline: { args: [], call: [], shape: {} }, // US-09 AC30: '{}', nothing to read
    cloudEraseHeld: { args: [], call: [], words: ['none', 'transient', 'definite', 'unknown', 'expired'] }, // S50b: 'none' with no cloud open
    uploadVerdictsJson: {
      args: ['request'],
      call: [JSON.stringify({ files: [{ name: 'a.pdf', bytes: 1 }], zipMembers: ['a.pdf'] })],
      shape: { limits: { fileBytes: 'number', zipBytes: 'number', zipMembers: 'number', folderBytes: 'number' }, files: ['string'], zipMembers: ['string'] },
    },
  };
  /** Where `answer` drops or retypes what `frozen` holds: [] when it holds at least the frozen shape. */
  function shapeFaults(frozen: unknown, answer: unknown, at = '$'): string[] {
    if (typeof frozen === 'string') return typeof answer === frozen ? [] : [`${at}: ${typeof answer}, not ${frozen}`];
    if (Array.isArray(frozen)) {
      if (!Array.isArray(answer) || !answer.length) return [`${at}: no array to check`];
      return answer.flatMap((item, i) => shapeFaults(frozen[0], item, `${at}[${i}]`));
    }
    if (typeof answer !== 'object' || answer === null) return [`${at}: not an object`];
    return Object.entries(frozen as Record<string, unknown>).flatMap(([key, inner]) =>
      key in answer ? shapeFaults(inner, (answer as Record<string, unknown>)[key], `${at}.${key}`) : [`${at}.${key}: missing`]);
  }

  it('every optional door is frozen, its arguments as they shipped and its answer holding the frozen shape', async () => {
    expect(Object.keys(optional.optionalDoors).sort()).toEqual(Object.keys(FROZEN_OPTIONAL_DOORS).sort());
    for (const [name, frozen] of Object.entries(FROZEN_OPTIONAL_DOORS)) {
      expect(optional.optionalDoors[name].args, name).toEqual(frozen.args);
      const door = (entry as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
      if (frozen.bytes) await expect(door(...frozen.call), name).rejects.toThrow('not open');
      else if (frozen.words) expect(frozen.words, name).toContain(await door(...frozen.call));
      else expect(shapeFaults(frozen.shape, JSON.parse(door(...frozen.call) as string)), name).toEqual([]);
    }
  });

  it('the frozen-shape check catches a dropped or retyped field', () => {
    const shape = [{ name: 'string', units: ['string'] }];
    expect(shapeFaults(shape, [{ name: 'Ferritin', units: ['µg/L'], extra: 1 }])).toEqual([]);
    expect(shapeFaults(shape, [{ units: ['µg/L'] }])).toEqual(['$[0].name: missing']);
    expect(shapeFaults(shape, [{ name: 'Ferritin', units: [1] }])).toEqual(['$[0].units[0]: number, not string']);
  });

  // US-61 / D14: an optional trailing argument or return field keeps the bridge id, so
  // over-the-air engines keep reaching the builds that serve it.
  it('optional additions name only contract doors, add only arguments and returns, and never repeat a contract arg', () => {
    expect(Object.keys(optional).sort()).toEqual(['about', 'doors', 'optionalDoors']);
    for (const [name, door] of Object.entries(optional.doors)) {
      expect(contract.doors[name], name).toBeDefined();
      expect(Object.keys(door).every((k) => k === 'optionalArgs' || k === 'optionalReturns'), name).toBe(true);
      expect((door.optionalArgs?.length ?? 0) > 0 || !!door.optionalReturns, `${name}: optionalArgs or optionalReturns`).toBe(true);
      for (const arg of optionalArgs(name)) expect(contract.doors[name].args, name).not.toContain(arg);
    }
  });

  // PR 399 re-check R1: the count alone let an optional argument move ahead of a contract one.
  it('each optional argument trails the contract ones, by name and in order, in entry.ts', () => {
    for (const name of Object.keys(optional.doors)) {
      if (optionalArgs(name).length === 0) continue; // a return-only addition: no optional argument to place
      expect(parameters(name), name).toEqual([...contract.doors[name].args, ...optionalArgs(name)]);
    }
  });

  // An older app sends only the contract arguments: the door must answer, and answer as if
  // each optional argument were passed as undefined.
  it('every optional door answers an older app\'s call as it answers undefined optional arguments', () => {
    for (const name of Object.keys(optional.doors)) {
      if (optionalArgs(name).length === 0) continue; // a return-only addition: no argument an older app could omit
      const args = SAMPLE_ARGS[name];
      expect(args, `${name}: add its contract arguments to SAMPLE_ARGS`).toBeDefined();
      expect(args.length, name).toBe(contract.doors[name].args.length);
      const door = (entry as unknown as Record<string, (...a: unknown[]) => string>)[name];
      const older = door(...args);
      const undefinedOptional = door(...args, ...optionalArgs(name).map(() => undefined));
      expect(untimed(older), name).toBe(untimed(undefinedOptional));
    }
  });

  // The id the app serves (EngineRelease.bridge). A real bridge change (anything an older
  // app cannot do without) moves the id and updates this literal; bridge-optional.json is
  // never a way around that, only for additions that work both ways (D3, D14). Moved
  // 2026-11-01 (Brad: still in beta, no downloads): US-07 AC8's labEgfrOutdated plus
  // US-61's optional isUS and usProducts; builds 3 and 4 no longer take OTA engines. Moved
  // 2026-11-02: US-12 AC20's limits in the chat context; build 5 no longer takes OTA engines.
  // Moved 2026-11-02 again: US-67's chatEditsJson door, a door an older app cannot serve.
  // Moved again 2026-11-02 for US-72 (D10): the healthRecords edit kind is named in the
  // contract, so an app that sends it never runs an older engine without the case.
  // Moved 2026-11-03: the two merged (US-67's door and the healthRecords edit).
  it('the contract hashes to exactly the bridge id the app serves (40fc97db4ca12547)', () => {
    const bytes = readFileSync(join(__dirname, 'bridge-contract.json'));
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toBe('40fc97db4ca12547');
    expect(contract.doors.screenJson.args).toEqual(['recordJson', 'nowIso', 'deviceId', 'unitsJson']);
    expect(optional.doors.screenJson.optionalArgs).toEqual(['isUS']);
  });

  // US-72 (D10): an engine without the healthRecords case would throw on it, so the
  // edit kind and its answer are in the contract, not an optional addition.
  it('names the healthRecords edit and its counts in applyEditJson and cloudEdit', () => {
    expect(contract.doors.applyEditJson.returns).toContain("healthRecords {kind:'healthRecords', records:[{sourceId, resourceType, fhirVersion, json}]}");
    expect(contract.doors.applyEditJson.returns).toContain('{added, corrected, withdrawn, alreadyInRecord, notRead}');
    expect(contract.doors.cloudEdit.returns).toContain('healthRecords');
  });

  it('every value the engine exports is in the contract', () => {
    const values = Object.entries(entry).filter(([, v]) => typeof v !== 'function').map(([k]) => k);
    expect(values.sort()).toEqual(Object.keys(contract.values).sort());
  });

  it('the natives the engine calls are the contract natives', () => {
    const used = [...members('shim.ts', 'Natives'), ...members('cloud-adapters.ts', 'CloudNatives')];
    expect(used.sort()).toEqual(Object.keys(contract.natives).sort());
  });

  it('the events the engine sends are the contract events', () => {
    const source = ['cloud.ts', 'cloud-adapters.ts'].map((file) => readFileSync(join(__dirname, file), 'utf8')).join('\n');
    const sent = new Set([...source.matchAll(/__native\.notify\('(\w+)'/g)].map((m) => m[1]));
    expect([...sent].sort()).toEqual([...contract.events].sort());
  });

  // US-56 AC8 (adversary R1, Codex R1): from 60 the vo2Bands Low line (p20) can exceed p50
  // (men 80 to 89), which an app built before it cannot draw. Naming the row and that meaning
  // in the contract moves the bridge id, so such an app refuses an engine that serves it.
  it('names the vo2Bands row and its Low line that can exceed p50', () => {
    const returns = contract.doors.screenJson.returns ?? '';
    expect(returns).toContain('myData.vo2Bands is the VO2 max bands row {sex, fromAge, toAge, p20, p50, p80} or null');
    expect(returns).toContain('p20 is the Low line');
    expect(returns).toContain('can exceed p50');
  });
});
