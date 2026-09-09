/** Fault-injection fixture, not a provider implementation. */
import { encode, emptyCheckpoint, IntegrityError, type Checkpoint } from './model';
import type { CheckpointRead, JournalStorage, ObjectRef, StoredObject } from './protocol';

export class MemoryJournal implements JournalStorage {
  atomicPublication = true;
  current: CheckpointRead | null;
  objects = new Map<string, StoredObject>();
  private objectRevision = 0;
  pageSize = 2;
  // Tests deliberately violate the advertised primitive to reproduce the unsafe protocol.
  ignorePrecondition = false;
  constructor(initial: Checkpoint = emptyCheckpoint()) { this.current = { bytes: encode(initial), revision: 1 }; }
  async readCheckpoint(): Promise<CheckpointRead | null> { return structuredClone(this.current); }
  async list(cursor?: string): Promise<{ objects: ObjectRef[]; next?: string }> {
    const rows = [...this.objects.values()].sort((a, b) => a.id < b.id ? -1 : 1);
    // A position in an array shifts when another cleaner deletes earlier rows.
    // A keyset cursor preserves discovery of objects present before this read.
    const remaining = cursor === undefined ? rows : rows.filter(row => row.id > cursor);
    const page = remaining.slice(0, this.pageSize);
    return {
      objects: page.map(({ id, revision }) => ({ id, revision })),
      ...(remaining.length > this.pageSize ? { next: page[page.length - 1].id } : {}),
    };
  }
  async readObject(id: string): Promise<StoredObject | null> { return structuredClone(this.objects.get(id) ?? null); }
  async createObject(id: string, bytes: string): Promise<void> {
    if (this.objects.has(id)) throw new IntegrityError('Immutable object already exists');
    this.objects.set(id, { id, revision: ++this.objectRevision, bytes });
  }
  async publish(bytes: string, expectedRevision: number): Promise<boolean> {
    if (!this.current || (!this.ignorePrecondition && this.current.revision !== expectedRevision)) return false;
    this.current = { bytes, revision: this.current.revision + 1 };
    return true;
  }
  async removeObject(ref: ObjectRef): Promise<boolean> {
    const object = this.objects.get(ref.id);
    if (!object) return true;
    if (object.revision !== ref.revision) return false;
    return this.objects.delete(ref.id);
  }
}
