/** Experimental register model, NOT a health-file schema or production replay engine. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../../packages/health-core/src/roadmap-file';

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const editSchema = z.object({
  key: identity,
  // The transaction that last wrote this register, or the initial baseline.
  expected: identity.nullable(),
  value: z.string().max(256),
}).strict();
const transactionSchema = z.object({
  protocol: z.literal(1), recordId: identity, generation,
  operationId: identity, writerId: identity,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  dependsOn: z.array(identity).max(32),
  edits: z.array(editSchema).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.edits.map(edit => edit.key)).size !== value.edits.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate register in transaction' });
  }
});
export type Transaction = z.infer<typeof transactionSchema>;
const registerSchema = z.object({ key: identity, value: z.string().max(256), head: identity.nullable() }).strict();
const outcomeSchema = z.enum(['applied', 'conflict', 'deferred']);
type Outcome = z.infer<typeof outcomeSchema>;
const entrySchema = z.object({ transaction: transactionSchema, digest: z.string(), outcome: outcomeSchema }).strict();
const checkpointSchema = z.object({
  protocol: z.literal(1), recordId: identity, generation,
  baseline: z.array(registerSchema).max(256),
  entries: z.array(entrySchema).max(128),
  registers: z.array(registerSchema).max(4096),
}).strict();
export type Checkpoint = z.infer<typeof checkpointSchema>;
const MAX_BYTES = 256 * 1024;

export class IntegrityError extends Error {
  constructor(message = 'Record sync integrity check failed') { super(message); this.name = 'IntegrityError'; }
}
export function encode(value: unknown): string { return stableStringify(value); }
export function digest(transaction: Transaction): string {
  return createHash('sha256').update(encode(transaction)).digest('hex');
}
function decode(bytes: string): unknown {
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new IntegrityError('Record sync capacity exceeded');
  try { return JSON.parse(bytes); } catch { throw new IntegrityError('Invalid record sync JSON'); }
}
export function readTransaction(bytes: string): Transaction {
  const parsed = transactionSchema.safeParse(decode(bytes));
  if (!parsed.success) throw new IntegrityError('Invalid transaction schema');
  return parsed.data;
}

/** Full commands remain inside receipts; a digest alone never establishes coverage. */
export function fold(base: Checkpoint, incoming: Transaction[]): Checkpoint {
  const transactions = new Map<string, Transaction>();
  const sequences = new Map<string, string>();
  for (const raw of [...base.entries.map(entry => entry.transaction), ...incoming]) {
    const transaction = readTransaction(encode(raw));
    if (transaction.recordId !== base.recordId || transaction.generation !== base.generation) {
      throw new IntegrityError('Wrong transaction authority');
    }
    const previous = transactions.get(transaction.operationId);
    if (previous && encode(previous) !== encode(transaction)) throw new IntegrityError('Operation identity reused');
    const sequenceKey = `${transaction.writerId}:${transaction.sequence}`;
    const previousId = sequences.get(sequenceKey);
    if (previousId && previousId !== transaction.operationId) throw new IntegrityError('Writer sequence reused');
    sequences.set(sequenceKey, transaction.operationId);
    transactions.set(transaction.operationId, transaction);
  }
  if (transactions.size > 128) throw new IntegrityError('Record sync capacity exceeded');
  const ordered = [...transactions.values()].sort((a, b) => a.operationId < b.operationId ? -1 : 1);
  const registers = new Map(base.baseline.map(row => [row.key, { ...row }]));
  if (registers.size !== base.baseline.length || base.baseline.some(row => row.head !== null)) {
    throw new IntegrityError('Invalid baseline');
  }
  const outcomes = new Map<string, Outcome>();
  // A common predecessor means competing claims, regardless of arrival order
  // or depth on unrelated keys. Neither arbitrary IDs nor clocks pick a winner.
  const claims = new Map<string, string[]>();
  for (const transaction of ordered) for (const edit of transaction.edits) {
    const key = encode([edit.key, edit.expected]);
    claims.set(key, [...(claims.get(key) ?? []), transaction.operationId]);
  }
  const competing = new Set([...claims.values()].filter(ids => ids.length > 1).flat());
  let progress = true;
  while (progress) {
    progress = false;
    for (const transaction of ordered) {
      if (outcomes.has(transaction.operationId)) continue;
      const dependencies = [...transaction.dependsOn, ...transaction.edits.flatMap(edit => edit.expected ? [edit.expected] : [])];
      // Unknown dependencies and cycles remain deferred, with all commands retained.
      if (dependencies.some(id => !outcomes.has(id))) continue;
      const conflict = competing.has(transaction.operationId)
        || dependencies.some(id => outcomes.get(id) !== 'applied')
        || transaction.edits.some(edit => (registers.get(edit.key)?.head ?? null) !== edit.expected);
      outcomes.set(transaction.operationId, conflict ? 'conflict' : 'applied');
      if (!conflict) for (const edit of transaction.edits) {
        registers.set(edit.key, { key: edit.key, value: edit.value, head: transaction.operationId });
      }
      progress = true;
    }
  }
  const result: Checkpoint = {
    protocol: 1, recordId: base.recordId, generation: base.generation,
    baseline: structuredClone(base.baseline),
    entries: ordered.map(transaction => ({ transaction, digest: digest(transaction), outcome: outcomes.get(transaction.operationId) ?? 'deferred' })),
    registers: [...registers.values()].sort((a, b) => a.key < b.key ? -1 : 1),
  };
  if (!checkpointSchema.safeParse(result).success || Buffer.byteLength(encode(result)) > MAX_BYTES) {
    throw new IntegrityError('Record sync capacity exceeded');
  }
  return result;
}

export function emptyCheckpoint(recordId = 'record', epoch = 0): Checkpoint {
  return { protocol: 1, recordId, generation: epoch, baseline: [], entries: [], registers: [] };
}
export function readCheckpoint(bytes: string): Checkpoint {
  const parsed = checkpointSchema.safeParse(decode(bytes));
  if (!parsed.success) throw new IntegrityError('Invalid checkpoint schema');
  const checkpoint = parsed.data;
  if (new Set(checkpoint.entries.map(entry => entry.transaction.operationId)).size !== checkpoint.entries.length
    || checkpoint.entries.some(entry => entry.digest !== digest(entry.transaction))
    || encode(fold(checkpoint, [])) !== encode(checkpoint)) {
    throw new IntegrityError('Checkpoint receipts do not cover their contents');
  }
  return checkpoint;
}
