/** Executable protocol specification over a fault-injectable store. No live adapter implements it. */
import { digest, emptyCheckpoint, encode, IntegrityError, readCheckpoint, readTransaction, fold, type Checkpoint, type Transaction } from './model';

/** Revisions must identify an incarnation, never reset when an ID is recreated. */
export interface ObjectRef { id: string; revision: number }
export interface StoredObject extends ObjectRef { bytes: string }
export interface CheckpointRead { bytes: string; revision: number }
export interface JournalStorage {
  readonly atomicPublication: boolean;
  readCheckpoint(): Promise<CheckpointRead | null>;
  /** Complete discovery of pre-existing objects despite concurrent deletion. Offset cursors do not suffice. */
  list(cursor?: string): Promise<{ objects: ObjectRef[]; next?: string }>;
  readObject(id: string): Promise<StoredObject | null>;
  createObject(id: string, bytes: string): Promise<void>;
  publish(bytes: string, expectedRevision: number): Promise<boolean>;
  removeObject(ref: ObjectRef): Promise<boolean>;
}
interface View { checkpoint: Checkpoint; revision: number; objects: StoredObject[]; transactions: Transaction[] }
const ATTEMPTS = 4;

async function checkpoint(storage: JournalStorage): Promise<{ value: Checkpoint; revision: number }> {
  const result = await storage.readCheckpoint();
  // Bootstrap and restoration need separate authority proof. Never infer newness.
  if (!result) throw new IntegrityError('Checkpoint is missing; recovery required');
  if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new IntegrityError('Invalid checkpoint revision');
  return { value: readCheckpoint(result.bytes), revision: result.revision };
}

/** Revision revalidation closes the empty-list race with a concurrent cleaner. */
export async function capture(storage: JournalStorage): Promise<View> {
  let observed: Awaited<ReturnType<typeof checkpoint>> | undefined;
  const observe = (next: Awaited<ReturnType<typeof checkpoint>>) => {
    if (observed && (next.value.recordId !== observed.value.recordId || next.value.generation < observed.value.generation
      || next.revision < observed.revision)) throw new IntegrityError('Checkpoint authority regressed');
    if (observed && next.revision === observed.revision && encode(next.value) !== encode(observed.value)) {
      throw new IntegrityError('Checkpoint changed without a revision change');
    }
    observed = next;
    return next;
  };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const initial = observe(await checkpoint(storage));
    const objects: StoredObject[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    let missing = false;
    do {
      const page = await storage.list(cursor);
      for (const ref of page.objects) {
        if (ids.has(ref.id)) throw new IntegrityError('Duplicate discovery identity');
        ids.add(ref.id);
        if (ids.size > 256) throw new IntegrityError('Record sync capacity exceeded');
        const object = await storage.readObject(ref.id);
        if (object && object.id !== ref.id) throw new IntegrityError('Object identity changed during discovery');
        if (!object || object.revision !== ref.revision) { missing = true; continue; }
        objects.push(object);
      }
      cursor = page.next;
      if (cursor !== undefined) {
        if (cursors.has(cursor) || cursors.size >= 256) throw new IntegrityError('Incomplete transaction discovery');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    const final = observe(await checkpoint(storage));
    if (missing || final.revision !== initial.revision) continue;
    const transactions = objects.map(object => readTransaction(object.bytes));
    if (transactions.some(transaction => transaction.recordId !== final.value.recordId
      || transaction.generation > final.value.generation)) throw new IntegrityError('Wrong transaction authority');
    return { checkpoint: final.value, revision: final.revision, objects, transactions };
  }
  throw new IntegrityError('A coherent record view could not be obtained');
}

export async function readView(storage: JournalStorage): Promise<Checkpoint> {
  const view = await capture(storage);
  return fold(view.checkpoint, view.transactions.filter(transaction => transaction.generation === view.checkpoint.generation));
}

/** Caller persists this exact identity/body BEFORE the first request; no new ID on retry. */
export async function submit(storage: JournalStorage, objectId: string, bytes: string): Promise<void> {
  const transaction = readTransaction(bytes);
  const current = await checkpoint(storage);
  if (transaction.recordId !== current.value.recordId || transaction.generation !== current.value.generation) {
    throw new IntegrityError('Transaction generation is no longer current');
  }
  const covered = current.value.entries.find(entry => entry.transaction.operationId === transaction.operationId);
  if (covered) {
    if (covered.digest !== digest(transaction)) throw new IntegrityError('Operation identity reused');
    return;
  }
  const existing = await storage.readObject(objectId);
  if (!existing) await storage.createObject(objectId, bytes);
  const written = await storage.readObject(objectId);
  if (!written || encode(readTransaction(written.bytes)) !== encode(transaction)) {
    throw new IntegrityError('Immutable upload could not be verified');
  }
}

function covers(checkpoint: Checkpoint, transaction: Transaction): boolean {
  if (checkpoint.recordId !== transaction.recordId) return false;
  if (checkpoint.generation > transaction.generation) return true; // explicit erasure barrier
  return checkpoint.generation === transaction.generation && checkpoint.entries.some(entry =>
    entry.transaction.operationId === transaction.operationId && entry.digest === digest(transaction));
}

interface CleanupResult { status: 'captured-clean' | 'cleanup-pending' | 'conflict' | 'dry-run'; captured: number; removed: number }
export async function compact(storage: JournalStorage, dryRun = false): Promise<CleanupResult> {
  if (!dryRun && !storage.atomicPublication) throw new IntegrityError('Atomic checkpoint publication is unproven');
  const view = await capture(storage);
  const candidate = fold(view.checkpoint, view.transactions.filter(transaction => transaction.generation === view.checkpoint.generation));
  const result = { captured: view.objects.length, removed: 0 };
  if (dryRun) return { ...result, status: 'dry-run' };
  if (!await storage.publish(encode(candidate), view.revision)) return { ...result, status: 'conflict' };
  const verified = await checkpoint(storage);
  if (verified.revision <= view.revision || verified.value.generation < candidate.generation
    || verified.value.recordId !== candidate.recordId
    || (verified.value.generation === candidate.generation
      && (encode(verified.value.baseline) !== encode(candidate.baseline)
        || !candidate.entries.every(entry => covers(verified.value, entry.transaction))))
    || !view.transactions.every(transaction => covers(verified.value, transaction))) {
    throw new IntegrityError('Published checkpoint coverage could not be verified');
  }
  let pending = false;
  // Exact captured identities only. Never list again to expand the deletion set.
  for (const object of view.objects) {
    try {
      if (await storage.removeObject(object)) result.removed++;
      else pending = true;
    } catch { pending = true; }
  }
  return { ...result, status: pending ? 'cleanup-pending' : 'captured-clean' };
}

/** Models an explicitly authorized barrier, not an authorization mechanism. */
export async function erase(storage: JournalStorage): Promise<boolean> {
  if (!storage.atomicPublication) throw new IntegrityError('Atomic checkpoint publication is unproven');
  const current = await checkpoint(storage);
  if (current.value.generation === Number.MAX_SAFE_INTEGER) throw new IntegrityError('Generation exhausted');
  return storage.publish(encode(emptyCheckpoint(current.value.recordId, current.value.generation + 1)), current.revision);
}
