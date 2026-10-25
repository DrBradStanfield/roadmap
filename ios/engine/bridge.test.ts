// US-25 AC18: the engine side of the native bridge matches its checked-in
// contract (bridge-contract.json). The contract's hash is the bridge id a
// downloaded engine must match, so drift here would let an engine reach an app
// that cannot serve it. The Swift side: EngineBridgeContractTests.swift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './entry';

const contract = JSON.parse(readFileSync(join(__dirname, 'bridge-contract.json'), 'utf8')) as {
  natives: Record<string, string>;
  events: string[];
  values: Record<string, string>;
  doors: Record<string, { args: string[] }>;
};

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
    for (const [name, fn] of doors) expect((fn as (...a: unknown[]) => unknown).length, name).toBe(contract.doors[name].args.length);
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
});
