# PENDING EXECUTION — do this immediately (post-compaction)

Brad authorized executing this without further questions. All decisions are locked.
**Order is non-negotiable: deploy cron-retirement → BACKUP → purge → verify.**
The backup is the only recovery path — do not run any DELETE before it succeeds.

## State as of 2026-06-12
- v2 is LIVE in production (/pages/roadmap = `health-roadmap-727`). Teardown of the old
  server data layer is committed + deployed. Dev Shopify app removed from the repo.
- The v1 reminder cron + `cleanupGuestProfiles` were RETIRED **in code** (commit `e97fa24`)
  but that code is **NOT yet deployed to Fly**. Until it deploys, `cleanupGuestProfiles`
  still runs daily and would cascade-delete kept guest chat — so deploy it BEFORE the purge.
- The purge SQL is ready (not run): `supabase/data-purge-2026-06.sql`.

## Decisions (locked)
- **KEEP ALL CHAT** (conversations, messages, match_events, guest sessions) — anonymized in
  place, nothing deleted.
- DELETE per-user health tables; ANONYMIZE profiles into pseudonymous FK anchors; anonymize audit_logs.
- SCRUB `auth.users` + `auth.identities` emails but KEEP the rows (safe for chat — FK is on
  the row id, not the email). Keep password hashes.
- Exclude the Discord bot row (`DISCORD_BOT_PROFILE_ID` is in `.env`).

## Execution steps (spawn fable agents per the orchestrator model)

### 1. Deploy the cron-retirement to Fly (stops `cleanupGuestProfiles` before the purge)
From repo root, the products.md symlink dance:
`cp -L docs/products.md /tmp/_p.md && rm docs/products.md && mv /tmp/_p.md docs/products.md`
→ `fly deploy` → `git checkout docs/products.md`. Confirm healthz 200 + chat still answers.

### 2. BACKUP first (no DELETE before this is verified)
`pg_dump`/`psql` are NOT installed and there is no direct Supabase PG URL in `.env`
(only `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` for REST, and `SESSION_DATABASE_URL` which is
the Shopify session store — verify whether it points at the same Postgres before relying on it).
Backup options, easiest first:
- **(a)** A `tsx` script using `@supabase/supabase-js` + `SUPABASE_SERVICE_KEY` that
  `SELECT *`s every affected table (profiles, health_*, medications*, supplements*, screenings,
  lab_values, health_documents, reminder_*, message_credit_transactions, audit_logs, chat_*,
  guest_chat_sessions) and writes them to JSON files under a gitignored backup dir
  (e.g. `~/roadmap-supabase-backup-<date>/`). This covers the PUBLIC schema (everything being
  changed). For `auth.users`/`auth.identities`, also SELECT+dump if a PG connection is available.
- **(b)** Supabase Dashboard → Database → Backups (download) — flag for Brad if (a) is insufficient.
Record the BEFORE row counts (the `data-purge-2026-06.sql` section 2 count query).

### 3. Run the purge
- **Public schema** (health-table DELETEs + profiles/chat/audit ANONYMIZE — sections 1–4 of the
  SQL): runnable via a `tsx` script with `@supabase/supabase-js` + `SUPABASE_SERVICE_KEY`
  (service key bypasses RLS), translating each statement; OR paste the SQL into the Supabase SQL
  editor. Fill the `<<REPLACE_WITH_DISCORD_BOT_PROFILE_ID>>` placeholder from `.env`.
- **auth scrub** (section 5: `auth.users` + `auth.identities` emails): the REST API CANNOT touch
  the `auth` schema. Needs a direct Postgres connection — try `SESSION_DATABASE_URL` via
  `node-postgres` (verify it's the same DB first: does it have a `profiles` table?). If no PG
  connection is reachable, leave auth for a manual Supabase-SQL-editor run and flag it.
- Re-run the count query; CONFIRM the KEEP tables (chat_*, guest_chat_sessions, ab_*) counts are
  UNCHANGED before treating it as done.

### 4. Verify after
- `SELECT email FROM auth.users WHERE email NOT LIKE 'anon-%@deleted.invalid'` returns only the bot.
- Chat history row counts unchanged; health tables empty; profiles demographics null.
- E2E: /pages/roadmap chat still answers (it uses client-sent context, not Supabase health data).

## Also flag to Brad (dashboard/theme — cannot do from CLI)
- Delete the Shopify **dev app** (client_id `899d91…`) from the Partner dashboard.
- Remove the **/pages/test** storefront page in Shopify admin (its extension is gone).

## NOT part of this — separate fresh thread
`docs/codebase-reduction-goal.md` is the prompt for a DIFFERENT future thread. Do not start it here.
