/**
 * An in-memory StorageAdapter that faithfully models optimistic concurrency
 * (a per-file version token that bumps on every write; a ConflictError when the
 * caller's expectedVersion is stale). Two adapters pointing at the SAME
 * `MemoryCloud` simulate two devices syncing through one cloud — which is
 * exactly the Phase-0 acceptance scenario ("two simulated devices converge with
 * no dup/loss").
 *
 * Used by the GitHub Pages storage self-test and (later) by unit tests. It is
 * NOT shipped as a user-selectable backend.
 */
import {
  ConflictError,
  type ReadResult,
  type StorageAdapter,
  type StoredFile,
  type WriteResult,
} from './adapter';

/** The shared "cloud" — one per simulated user, shared by their devices. */
export class MemoryCloud {
  /** Serialized record files, keyed by file name. */
  files = new Map<string, { json: string; version: number; modified?: string }>();
  docs = new Map<string, Blob>();
}

export class MemoryAdapter implements StorageAdapter {
  readonly id = 'memory' as const;
  readonly label = 'In-memory (test)';
  private connected = false;

  constructor(public readonly cloud: MemoryCloud = new MemoryCloud()) {}

  async connect(): Promise<void> {
    this.connected = true;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    signal?.throwIfAborted();
    const entry = this.cloud.files.get(fileName);
    if (entry == null) return { body: null, version: null };
    return { body: JSON.parse(entry.json), version: String(entry.version) };
  }

  async write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    signal?.throwIfAborted();
    const entry = this.cloud.files.get(fileName);
    const current = entry == null ? null : String(entry.version);
    if (expectedVersion !== current) {
      throw new ConflictError(`expected version ${expectedVersion}, but remote is ${current}`);
    }
    const version = (entry?.version ?? 0) + 1;
    this.cloud.files.set(fileName, { json: JSON.stringify(body), version, modified: new Date().toISOString() });
    return { version: String(version) };
  }

  async readDocument(ref: string, signal?: AbortSignal): Promise<Blob> {
    signal?.throwIfAborted();
    const blob = this.cloud.docs.get(ref);
    if (!blob) throw new Error(`document not found: ${ref}`);
    return blob;
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    this.cloud.docs.set(ref, bytes);
  }

  /** Records and documents alike, one level deep — a folder root holds both, as a real one does. */
  async list(folder: string, signal?: AbortSignal): Promise<StoredFile[]> {
    signal?.throwIfAborted();
    const inFolder = (name: string) => (folder ? name.startsWith(`${folder}/`) : !name.includes('/'));
    const out: StoredFile[] = [];
    for (const [name, entry] of this.cloud.files) if (inFolder(name)) out.push({ name, ref: name, size: entry.json.length, modified: entry.modified ?? '' });
    for (const [name, blob] of this.cloud.docs) if (inFolder(name)) out.push({ name, ref: name, size: blob.size, modified: '' });
    return out;
  }

  async remove(fileName: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.cloud.files.delete(fileName);
  }
}
