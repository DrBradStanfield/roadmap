/**
 * US-09 AC59 (lead H410): the failures each log-off reader is pinned on. A reader stays quiet for a refusal whose
 * typed reason is `writes-stopped`, whatever its class, and reports anything else: a refusal for another reason, and
 * a log-off refusal SyncManager rewrapped after a write (outcome `may-have-landed`), as the class test did.
 */
import { StorageError } from '@roadmap/health-core/adapter';
import { WritesStoppedError } from '../lib/error-diagnostics';

export const WRITES_STOPPED_CASES = [
  { name: 'a log-off refusal', error: () => new WritesStoppedError(), reports: 0 },
  { name: 'the session gate refusal (reason only)', error: () => new StorageError('Device files closed', undefined, undefined, undefined, 'writes-stopped', 'refused'), reports: 0 },
  { name: 'a log-off refusal rewrapped after a write', error: () => new StorageError('Synthetic rewrap', undefined, new WritesStoppedError(), undefined, 'writes-stopped', 'may-have-landed'), reports: 1 },
  { name: 'another refusal', error: () => new StorageError('Synthetic refusal', undefined, undefined, 403, undefined, 'refused'), reports: 1 },
];
