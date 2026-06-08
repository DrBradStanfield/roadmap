/**
 * An in-memory StorageAdapter that faithfully models optimistic concurrency
 * (a version token that bumps on every write; a ConflictError when the caller's
 * expectedVersion is stale). Two adapters pointing at the SAME `MemoryCloud`
 * simulate two devices syncing through one cloud file — which is exactly the
 * Phase-0 acceptance scenario ("two simulated devices converge with no dup/loss").
 *
 * Used by the GitHub Pages storage self-test and (later) by unit tests. It is
 * NOT shipped as a user-selectable backend.
 */
import type { RoadmapFile } from '@roadmap/health-core';
import {
  ConflictError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';

/** The shared "cloud" — one per simulated user, shared by their devices. */
export class MemoryCloud {
  /** Serialized RoadmapFile, or null if no file yet. */
  fileJson: string | null = null;
  version = 0;
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

  async read(): Promise<ReadResult> {
    if (this.cloud.fileJson == null) return { file: null, version: null };
    return {
      file: JSON.parse(this.cloud.fileJson) as RoadmapFile,
      version: String(this.cloud.version),
    };
  }

  async write(file: RoadmapFile, expectedVersion: string | null): Promise<WriteResult> {
    const current = this.cloud.fileJson == null ? null : String(this.cloud.version);
    if (expectedVersion !== current) {
      throw new ConflictError(`expected version ${expectedVersion}, but remote is ${current}`);
    }
    this.cloud.fileJson = JSON.stringify(file);
    this.cloud.version += 1;
    return { version: String(this.cloud.version) };
  }

  async readDocument(ref: string): Promise<Blob> {
    const blob = this.cloud.docs.get(ref);
    if (!blob) throw new Error(`document not found: ${ref}`);
    return blob;
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    this.cloud.docs.set(ref, bytes);
  }
}
