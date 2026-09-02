# health-core

`file-adapter.ts` and `sync-manager.ts` carry the write-safety contract for
`health-roadmap.json`. What each one actually does:

**`file-adapter.ts`** talks to one local file.

- **Lock.** A write takes an exclusive `.lock` sibling (atomic `wx` open) for
  the whole check-backup-replace sequence, so a second writer on the same
  machine waits its turn instead of racing the first. A lock older than 10
  seconds is treated as abandoned and cleared.
- **Backups.** Before every write, the record is copied beside itself as
  `<file>.bak-<ISO timestamp>`. The newest three are kept; older ones are
  pruned on the same write.
- **Temp-file-then-rename.** The new bytes go to `<file>.tmp-<pid>`, then
  `renameSync` swaps it over the original, so a crash mid-write leaves the old
  file whole rather than half-written.
- **Conflict check.** Each write compares a SHA-256 of the bytes it read
  against what's on disk now. A mismatch throws `ConflictError`, which
  `sync-manager.ts` catches, re-reads, and re-merges before retrying.

**`sync-manager.ts`** sits above one adapter and runs the read-merge-write
loop.

- **Merge on conflict.** On `ConflictError`, `SyncManager.save()` re-reads the
  remote file, merges the caller's edit into it via the document's `merge()`,
  and retries the write, up to 5 attempts.
- **Verify after write.** After a successful write it re-reads the file and
  confirms the lamport clock didn't regress and every row id it just wrote is
  still present, throwing `LostUpdateError` (retried the same way) if not.

**`adapter.ts`** defines the shared interface, plus `fetchOrFail()`: it wraps
`fetch` so a network failure (a dead DNS lookup, a severed socket) becomes a
typed `StorageError` instead of a bare `TypeError`, so a caller can tell "the
provider didn't answer" from a bug of ours rather than guessing.
