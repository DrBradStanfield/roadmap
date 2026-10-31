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
  doors: Record<string, { optionalArgs: string[]; optionalReturns?: string }>;
};
const arity = (name: string) => contract.doors[name].args.length + (optional.doors[name]?.optionalArgs.length ?? 0);

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
      expect(door.optionalArgs.length, name).toBeGreaterThan(0);
      for (const arg of door.optionalArgs) expect(contract.doors[name].args, name).not.toContain(arg);
    }
  });

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
