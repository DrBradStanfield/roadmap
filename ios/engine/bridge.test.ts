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
};
const optionalArgs = (name: string) => optional.doors[name]?.optionalArgs ?? [];
const arity = (name: string) => contract.doors[name].args.length + optionalArgs(name).length;

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
  it('every door the engine exports is in the contract, with its arity', () => {
    const doors = Object.entries(entry).filter(([, v]) => typeof v === 'function');
    expect(doors.map(([k]) => k).sort()).toEqual(Object.keys(contract.doors).sort());
    for (const [name, fn] of doors) expect((fn as (...a: unknown[]) => unknown).length, name).toBe(arity(name));
  });

  // US-61 / D14: an optional trailing argument or return field keeps the bridge id, so
  // over-the-air engines still reach builds 3 and 4 (bridge 2d467ff50c66c42d).
  it('optional additions name only contract doors, add only arguments and returns, and never repeat a contract arg', () => {
    expect(Object.keys(optional).sort()).toEqual(['about', 'doors']);
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
      expect(parameters(name), name).toEqual([...contract.doors[name].args, ...optionalArgs(name)]);
    }
  });

  // An older app sends only the contract arguments: the door must answer, and answer as if
  // each optional argument were passed as undefined.
  it('every optional door answers an older app\'s call as it answers undefined optional arguments', () => {
    for (const name of Object.keys(optional.doors)) {
      const args = SAMPLE_ARGS[name];
      expect(args, `${name}: add its contract arguments to SAMPLE_ARGS`).toBeDefined();
      expect(args.length, name).toBe(contract.doors[name].args.length);
      const door = (entry as unknown as Record<string, (...a: unknown[]) => string>)[name];
      const older = door(...args);
      const undefinedOptional = door(...args, ...optionalArgs(name).map(() => undefined));
      expect(untimed(older), name).toBe(untimed(undefinedOptional));
    }
  });

  // The id builds 3 and 4 carry. A real bridge change (anything an older app cannot do
  // without) moves the id and updates this literal; bridge-optional.json is never a way
  // around that, only for additions that work both ways (D3, D14).
  it('the contract keeps the bridge id builds 3 and 4 carry (US-61 adds isUS and usProducts as optional)', () => {
    const bytes = readFileSync(join(__dirname, 'bridge-contract.json'));
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toBe('2d467ff50c66c42d');
    expect(contract.doors.screenJson.args).toEqual(['recordJson', 'nowIso', 'deviceId', 'unitsJson']);
    expect(optional.doors.screenJson.optionalArgs).toEqual(['isUS']);
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
