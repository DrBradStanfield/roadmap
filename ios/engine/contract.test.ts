// I-2 step 1: contract.ts is the bridge's one source. The checked-in JSON pair is generated
// from it byte for byte, so the bridge id (the hashed file's SHA-256 prefix) is the
// contract's. A contract edit without `npx tsx ios/scripts/gen-contract.ts` fails here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from './entry';
import { DOORS, type Door } from './contract';
import { bridgeContractJson, bridgeOptionalJson } from './contract-json';

const file = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe('bridge contract source (I-2, US-25 AC18)', () => {
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
});
