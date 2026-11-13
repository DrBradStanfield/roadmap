// Generates the Swift side of the bridge from contract.ts (I-2 step 3), through one neutral
// description, contract.schema.json, that a Kotlin generator can read later. Checked in, not
// built: a clean clone builds with no generation step, and a review sees the Swift diff.
// contract-drift.test.ts fails when a checked-in file differs from what this writes.
import { createHash } from 'node:crypto';
import * as z from '../../packages/health-core/src/zod';
import { DOORS, EDIT, EVENTS, NATIVES, VALUES, type Arg, type Door } from './contract';
import { bridgeContractJson, bridgeOptionalJson } from './contract-json';

/** Every file generated from contract.ts, by its path under ios/. */
export function generatedFiles(): Record<string, string> {
  return {
    'engine/bridge-contract.json': bridgeContractJson(),
    'engine/bridge-optional.json': bridgeOptionalJson(),
    'engine/contract.schema.json': contractSchemaJson(),
    'HealthRoadmap/Engine/Generated/EngineContract.swift': engineContractSwift(),
    'HealthRoadmap/Engine/Generated/EngineDoors.swift': engineDoorsSwift(),
  };
}

/** A wire type, neutral: what any platform's generator reads. */
interface WireType { type: 'string' | 'number' | 'int' | 'bool' | 'unknown' | 'bytes' | 'callback' | 'array' | 'ref'; items?: WireType; ref?: string; enum?: string[] }
type WireField = WireType & { name: string; optional?: true; nullable?: true };
type Named = { type: 'object'; fields: WireField[] } | { type: 'union'; discriminator: string; cases: Array<{ tag: string; fields: WireField[] }> };

const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
const metaOf = (schema: z.ZodType) => z.globalRegistry.get(schema) as { id?: string; wire?: string } | undefined;

/** Optional, nullable and default peeled off a schema, and what they said. */
function peel(schema: z.ZodType): { inner: z.ZodType; optional: boolean; nullable: boolean } {
  let inner = schema, optional = false, nullable = false;
  for (;;) {
    const def = defOf(inner);
    if (def.type === 'optional' || def.type === 'default') optional = true;
    else if (def.type === 'nullable') nullable = true;
    else return { inner, optional, nullable };
    inner = def.innerType as z.ZodType;
  }
}

function wireType(schema: z.ZodType, named: Map<string, Named>): WireType {
  const def = defOf(schema);
  const meta = metaOf(schema);
  switch (def.type) {
    case 'string': return { type: 'string' };
    case 'number': return { type: (schema as unknown as { format?: string }).format === 'safeint' ? 'int' : 'number' };
    case 'boolean': return { type: 'bool' };
    case 'enum': return { type: 'string', enum: Object.values(def.entries as Record<string, string>) };
    case 'unknown': return { type: 'unknown' };
    case 'custom':
      if (meta?.wire === 'bytes' || meta?.wire === 'callback') return { type: meta.wire };
      break;
    case 'array': return { type: 'array', items: wireType(def.element as z.ZodType, named) };
    case 'object':
    case 'union':
      if (!meta?.id) break;
      if (!named.has(meta.id)) {
        named.set(meta.id, { type: 'object', fields: [] }); // reserved before its fields, for a cycle
        named.set(meta.id, def.type === 'object' ? { type: 'object', fields: fields(schema, named) } : {
          type: 'union', discriminator: def.discriminator as string,
          cases: (def.options as z.ZodType[]).map((option) => {
            const [tagField, ...rest] = fields(option, named);
            if (tagField?.name !== def.discriminator) throw new Error(`${meta.id}: each case starts with its ${String(def.discriminator)}`);
            return { tag: String((defOf((option as z.ZodObject).shape[tagField.name]).values as unknown[])[0]), fields: rest };
          }),
        });
      }
      return { type: 'ref', ref: meta.id };
  }
  throw new Error(`contract.ts: no wire type for a ${def.type}${meta?.id ? '' : ' (an object or union needs .meta({ id }))'}`);
}

function fields(object: z.ZodType, named: Map<string, Named>): WireField[] {
  return Object.entries((object as z.ZodObject).shape).map(([name, schema]) => {
    const { inner, optional, nullable } = peel(schema as z.ZodType);
    const literal = defOf(inner).type === 'literal';
    return { name, ...(literal ? { type: 'string' as const } : wireType(inner, named)), ...(optional && { optional: true as const }), ...(nullable && { nullable: true as const }) };
  });
}

const argFields = (args: readonly Arg[] | undefined, named: Map<string, Named>): WireField[] =>
  (args ?? []).map(([name, schema]) => {
    const { inner, optional, nullable } = peel(schema);
    return { name, ...wireType(inner, named), ...(optional && { optional: true as const }), ...(nullable && { nullable: true as const }) };
  });

/** contract.schema.json: every door, its arguments and typed answer, and the named shapes. */
export function contractSchema() {
  const named = new Map<string, Named>();
  wireType(EDIT, named);
  const doors = Object.fromEntries((Object.entries(DOORS) as [string, Door][]).map(([name, door]) => [name, {
    kind: door.kind, ...(door.optionalDoor && { optionalDoor: true }),
    args: argFields(door.args, named), ...(door.optionalArgs && { optionalArgs: argFields(door.optionalArgs, named) }),
    ...(door.result && { result: wireType(door.result, named) }),
  }]));
  return {
    about: 'Generated from ios/engine/contract.ts (npx tsx ios/scripts/gen-contract.ts): the bridge, neutral, for each platform\'s generator.',
    bridge: bridgeId(), natives: Object.keys(NATIVES), events: EVENTS, values: Object.keys(VALUES), doors,
    types: Object.fromEntries([...named].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export const contractSchemaJson = () => JSON.stringify(contractSchema(), null, 2) + '\n';
/** The first 16 hex digits of contract.schema.json's SHA-256: the generated files carry it. */
export const contractHash = () => createHash('sha256').update(contractSchemaJson()).digest('hex').slice(0, 16);
export const bridgeId = () => createHash('sha256').update(bridgeContractJson()).digest('hex').slice(0, 16);

// --- Swift -----------------------------------------------------------------------------------

const HEADER = (hash: string) => `// Generated from ios/engine/contract.ts by \`npx tsx ios/scripts/gen-contract.ts\`. Never edit it:
// ios/engine/contract-drift.test.ts fails when it differs from what the contract generates.
// contractHash: ${hash}
`;

function swiftType(type: WireType): string {
  switch (type.type) {
    case 'string': return 'String';
    case 'number': return 'Double';
    case 'int': return 'Int';
    case 'bool': return 'Bool';
    case 'unknown': return 'OpaqueJSON';
    case 'bytes': return 'Data';
    case 'callback': return 'AnyObject';
    case 'array': return `[${swiftType(type.items!)}]`;
    case 'ref': return type.ref!;
  }
}
const fieldType = (field: WireField) => swiftType(field) + (field.optional || field.nullable ? '?' : '');
const quote = (text: string) => JSON.stringify(text);

/** EngineContract.swift: the bridge's facts and its wire types, Foundation only. */
export function engineContractSwift(): string {
  const schema = contractSchema();
  const lines = [HEADER(contractHash()), 'import Foundation', '', 'extension EngineRelease {',
    '    /// The native bridge this binary serves: the first 16 hex digits of the SHA-256 of',
    '    /// ios/engine/bridge-contract.json (generated from contract.ts).',
    `    static let bridge = ${quote(schema.bridge)}`,
    '    /// The first 16 hex digits of the SHA-256 of ios/engine/contract.schema.json.',
    `    static let contractHash = ${quote(contractHash())}`,
    '    /// Every door the engine must have (the contract\'s doors), checked by the self-test.',
    '    static let doors = [',
    ...chunk(Object.entries(schema.doors).filter(([, door]) => !('optionalDoor' in door)).map(([name]) => quote(name)).sort(), 6).map((row) => `        ${row.join(', ')},`),
    '    ]', '}'];
  for (const [name, shape] of Object.entries(schema.types)) lines.push('', ...(shape.type === 'object' ? swiftStruct(name, shape.fields) : swiftUnion(name, shape)));
  return lines.join('\n') + '\n';
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, at * size + size));
}

function swiftStruct(name: string, fields: WireField[]): string[] {
  return [`struct ${name}: Codable, Equatable, Hashable, Sendable {`, ...fields.map((field) => `    let ${field.name}: ${fieldType(field)}`), '}'];
}

/** A discriminated union as an enum whose cases carry the fields; encoded with its tag. */
function swiftUnion(name: string, union: Extract<Named, { type: 'union' }>): string[] {
  const keys = [...new Set([union.discriminator, ...union.cases.flatMap((c) => c.fields.map((f) => f.name))])];
  const param = (field: WireField) => `${field.name}: ${fieldType(field)}${field.optional ? ' = nil' : ''}`;
  const lines = [`enum ${name}: Encodable, Equatable, Sendable {`];
  for (const c of union.cases) lines.push(`    case ${c.tag}${c.fields.length ? `(${c.fields.map(param).join(', ')})` : ''}`);
  lines.push('', `    private enum Key: String, CodingKey {`, `        case ${keys.join(', ')}`, '    }', '',
    '    func encode(to encoder: Encoder) throws {', '        var json = encoder.container(keyedBy: Key.self)', '        switch self {');
  for (const c of union.cases) {
    lines.push(`        case .${c.tag}${c.fields.length ? `(${c.fields.map((f) => `let ${f.name}`).join(', ')})` : ''}:`,
      `            try json.encode(${quote(c.tag)}, forKey: .${union.discriminator})`);
    // A nullable field is written as null; one that is only optional is left out when nil.
    for (const f of c.fields) lines.push(`            try json.${f.optional && !f.nullable ? 'encodeIfPresent' : 'encode'}(${f.name}, forKey: .${f.name})`);
  }
  lines.push('        }', '    }', '}');
  return lines;
}

/** EngineDoors.swift: one typed method per door on HealthEngine, the app's only way to a door. */
export function engineDoorsSwift(): string {
  const schema = contractSchema();
  const lines = [HEADER(contractHash()), 'import Foundation', 'import JavaScriptCore', '', 'extension HealthEngine {'];
  for (const [name, door] of Object.entries(schema.doors)) lines.push(...swiftDoor(name, door as DoorSchema));
  lines.push('}');
  return lines.join('\n') + '\n';
}

type DoorSchema = { kind: Door['kind']; optionalDoor?: true; args: WireField[]; optionalArgs?: WireField[]; result?: WireType };

function swiftDoor(name: string, door: DoorSchema): string[] {
  const method = `door${name[0].toUpperCase()}${name.slice(1)}`;
  // A contract argument is always sent; an optional trailing one only when given.
  const params = [...door.args.map((a) => `${a.name}: ${swiftType(a)}${a.nullable ? '?' : ''}`), ...(door.optionalArgs ?? []).map((a) => `${a.name}: ${swiftType(a)}? = nil`)];
  const value = (a: WireField) => (a.type === 'bytes' ? (a.nullable ? `${a.name}.map { arrayBuffer($0) as Any } ?? NSNull()` : `arrayBuffer(${a.name})`)
    : a.nullable ? `${a.name}.map { $0 as Any } ?? NSNull()` : a.name);
  const fixed = `[${door.args.map(value).join(', ')}]`;
  const body: string[] = [];
  let args = fixed;
  if (door.optionalArgs?.length) {
    body.push(`        var arguments: [Any] = ${fixed}`, ...door.optionalArgs.map((a) => `        if let ${a.name} { arguments.append(${value({ ...a, nullable: undefined })}) }`));
    args = 'arguments';
  }
  const call = door.optionalDoor ? 'optionalCall' : door.kind === 'promise' ? 'callAsync' : 'call';
  const answer = door.optionalDoor ? '?' : '';
  const doc = `    /// \`${name}\`: ${door.kind === 'settle' ? 'a settle door, read through settledJson' : door.kind === 'promise' ? 'answers a Promise' : 'answers at once'}${door.optionalDoor ? '; nil from an engine without it' : ''}.`;
  const signature = (generic: string, extra: string, returns: string, effects: string) =>
    `    func ${method}${generic}(${[...(extra.startsWith('_') ? [extra] : []), ...params, ...(extra && !extra.startsWith('_') ? [extra] : [])].join(', ')}) ${effects} -> ${returns} {`;
  if (door.result && door.kind !== 'sync') throw new Error(`${name}: only a sync door's answer is typed yet`);
  if (door.kind === 'settle') {
    return ['', doc, signature('<T: Decodable>', '_ type: T.Type', 'T', 'throws'), ...body, `        try settled(type, ${quote(name)}, ${args})`, '    }'];
  }
  if (door.kind === 'promise') {
    return ['', doc, signature('', '', `String${answer}`, 'async throws'), ...body, `        try await ${call}(${quote(name)}, ${args}${door.optionalDoor ? ', read: { $0.isUndefined ? "" : $0.toString() }' : ''})`, '    }',
      '', `    /// \`${name}\`, its settled value read by \`read\` on the engine's queue.`,
      signature('<T: Sendable>', 'read: @escaping (JSValue) -> T', `T${answer}`, 'async throws'), ...body, `        try await ${call}(${quote(name)}, ${args}, read: read)`, '    }'];
  }
  // A typed answer is decoded here, so the app never reads that door's JSON by hand.
  if (door.result && !door.optionalDoor) {
    const type = swiftType(door.result);
    return ['', doc, signature('', '', type, 'throws'), ...body, `        try JSONDecoder().decode(${type}.self, from: Data(call(${quote(name)}, ${args}).utf8))`, '    }'];
  }
  return ['', doc, signature('', '', `String${answer}`, 'throws'), ...body, `        try ${call}(${quote(name)}, ${args})`, '    }'];
}
