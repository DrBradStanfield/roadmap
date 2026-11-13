// Generates the bridge's JSON pair from contract.ts (I-2). bridge-contract.json keeps its
// hand-set layout, since its bytes are the bridge id; bridge-optional.json is plain 2-space JSON.
import { CONTRACT_ABOUT, DOORS, EVENTS, NATIVES, OPTIONAL_ABOUT, VALUES, type Arg, type Door } from './contract';

const doors = Object.entries(DOORS) as [string, Door][];
const names = (args: readonly Arg[]) => args.map(([name]) => name);
const q = (value: string) => JSON.stringify(value);
const list = (items: readonly string[]) => `[${items.map(q).join(', ')}]`;
const entries = (rows: string[]) => rows.join(',\n');

/** bridge-contract.json, byte for byte: the hashed file. */
export function bridgeContractJson(): string {
  const prose = (record: Record<string, string>) => entries(Object.entries(record).map(([k, v]) => `    ${q(k)}: ${q(v)}`));
  const contractDoors = doors.filter(([, door]) => !door.optionalDoor)
    .map(([name, door]) => `    ${q(name)}: { "args": ${list(names(door.args))}, "returns": ${q(door.returns)} }`);
  return `{
  "about": ${q(CONTRACT_ABOUT)},
  "natives": {
${prose(NATIVES)}
  },
  "events": ${list(EVENTS)},
  "values": {
${prose(VALUES)}
  },
  "doors": {
${entries(contractDoors)}
  }
}
`;
}

/** bridge-optional.json, byte for byte: the both-way additions, outside the hash. */
export function bridgeOptionalJson(): string {
  const additions = doors.filter(([, door]) => door.optionalAt !== undefined)
    .sort(([, a], [, b]) => a.optionalAt! - b.optionalAt!)
    .map(([name, door]) => [name, {
      ...(door.optionalArgs && { optionalArgs: names(door.optionalArgs) }),
      ...(door.optionalReturns && { optionalReturns: door.optionalReturns }),
    }]);
  const optionalDoors = doors.filter(([, door]) => door.optionalDoor)
    .map(([name, door]) => [name, { args: names(door.args), returns: door.returns }]);
  const file = { about: OPTIONAL_ABOUT, doors: Object.fromEntries(additions), optionalDoors: Object.fromEntries(optionalDoors) };
  return JSON.stringify(file, null, 2) + '\n';
}
