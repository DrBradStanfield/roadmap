# US-38 · Record sync and cleanup proof gate

As a user, I want confirmed record changes to survive competing writers and
cleanup, with one canonical health JSON left when work settles.

This first PR implements an executable specification, not a live migration.
The [plan](record-sync-and-cleanup-plan.md) governs the eventual rollout.

- AC1: A captured transaction is never deleted before a protected checkpoint
  contains its complete commands and derived outcome, or a newer authorized
  erasure barrier retires its generation. A digest alone is insufficient.
- AC2: Competing publication either preserves earlier coverage or conflicts.
  An unproven publication primitive cannot perform destructive compaction.
- AC3: Retries preserve operation identity and payload. Changed payloads or
  reused writer sequences fail visibly. Sequence gaps remain valid.
- AC4: A read/export revalidates its checkpoint after complete discovery.
  Concurrent compaction cannot produce a silently stale empty-list view.
- AC5: Missing dependencies stay deferred with commands retained. Delivery
  order, including separate compactions, gives the same register-model result.
  Competing claims stay visible; a transaction applies all its edits or none.
- AC6: Crashes, failed removals and late arrivals preserve coverage. Quiescent
  successful cleanup leaves one checkpoint and no transaction objects.
  Cleanup uses exact captured identities and never sweeps unknown files.
- AC7: Old-generation work cannot restore erased contents. Missing checkpoints,
  corrupt/unknown formats, repeated cursors and capacity exhaustion fail closed.
  Unsafe backup restoration and legacy in-flight writes remain rollout gates.
- AC8: The Drive probe refuses non-synthetic content, uses an explicit test
  file and reports observations without enabling production cleanup. A local
  model or successful HTTP probe alone is not a provider safety guarantee.

Usage signal: the local proof command reports schedule and cleanup counts;
CI runs the fault tests. No health data, operation IDs, hashes or credentials
enter product telemetry. Product-facing signals belong to the later rollout.

Tests: `tools/record-sync/*.test.ts`; operational examples are in the
[proof guide](record-sync-proof.md). Clinical validation, actual FHIR replay,
browser IndexedDB, durable hosted receipts and migration are outside this model.
