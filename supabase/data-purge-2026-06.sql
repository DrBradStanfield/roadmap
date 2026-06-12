-- ============================================================================
-- ONE-TIME PRODUCTION DATA PURGE — June 2026
-- ============================================================================
-- Run ONCE, MANUALLY, in the Supabase SQL Editor, AFTER taking a pg_dump
-- backup. Run the sections in order, one at a time — do NOT paste the whole
-- file and execute blindly. The COMMIT at the end is deliberately commented
-- out; you must verify the in-transaction counts first.
--
-- WHAT THIS DOES (decisions baked in):
--
--   KEEP (every row survives, anonymized only):
--     chat_conversations, chat_messages, chat_match_events,
--     guest_chat_sessions
--     - All content, tokens, and pseudonymous identifiers stay:
--       session_token, external_id, conversation_id, discord_message_id,
--       message content, titles, router output.
--     - Scrubbed: chat_messages.error_detail (raw API error text),
--       chat_match_events.router_error (same class of raw error text),
--       guest_chat_sessions.ip_address (NOT NULL → overwritten with 0.0.0.0).
--
--   SCRUB (rows kept as pseudonymous anchors so chat FKs stay valid):
--     profiles — null demographics (sex, birth_year, birth_month, height,
--     unit_system), synthetic email 'anon-<id>@deleted.invalid', null
--     shopify_customer_id / first_name / last_name / unsubscribe_token /
--     subscription fields, message_credits = 0.
--     The DISCORD_BOT_PROFILE_ID row is EXCLUDED (shared anchor for all
--     Discord conversations — see deleteAllUserData() safeguard in
--     app/lib/supabase.server.ts).
--
--   DELETE (all rows — per-user health data):
--     health_measurements, lab_values, health_documents,
--     medication_history, medications, supplement_history, supplements,
--     screenings, reminder_preferences, reminder_log,
--     message_credit_transactions
--
--   ANONYMIZE:
--     audit_logs — UPDATE user_id = NULL (operational record kept, PII link
--     severed). Rows are NOT deleted.
--
--   UNTOUCHED:
--     ab_tests + ab_events (A/B survivor; ab_events.visitor_id is a
--       pseudonymous cookie id, not health data).
--     auth.users — COMPLETELY UNTOUCHED. NOTE: auth.users still holds
--       plaintext emails + password hashes for every scrubbed profile. The
--       profiles.id → auth.users(id) FK is NOT dropped. auth.users can be
--       scrubbed separately later if desired; until then the purge is
--       pseudonymization, not full erasure.
--     reminder_optin_v2 — active v2 opt-in store (emails by design),
--       deliberately out of scope.
--     cron_lock, youtube_bot_log — operational, out of scope.
--
--   NO CASCADE SURPRISES: every per-user table FKs to profiles(id) with
--   ON DELETE CASCADE, but profiles rows are KEPT (scrubbed), so nothing
--   cascades. All deletes below are explicit. health_measurements has a
--   self-FK (corrects_id, ON DELETE SET NULL) — irrelevant when deleting the
--   whole table. chat_match_events FKs chat_messages — both are kept.
--
--   CONTEXT: the v1 reminder cron (including cleanupGuestProfiles) is being
--   retired in code in the same change-set, so no future guest-profile
--   deletion will cascade-delete the kept chat rows.
--
-- !!! BEFORE RUNNING: replace REPLACE_WITH_DISCORD_BOT_PROFILE_ID below with
-- the DISCORD_BOT_PROFILE_ID env value (a UUID, from Fly.io secrets / .env).
-- If you forget, the UUID cast fails and the transaction aborts — by design.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — BEFORE COUNTS. Run this first and RECORD the output.
-- ============================================================================

SELECT 'profiles' AS tbl, COUNT(*) FROM profiles
UNION ALL SELECT 'chat_conversations', COUNT(*) FROM chat_conversations
UNION ALL SELECT 'chat_messages', COUNT(*) FROM chat_messages
UNION ALL SELECT 'chat_match_events', COUNT(*) FROM chat_match_events
UNION ALL SELECT 'guest_chat_sessions', COUNT(*) FROM guest_chat_sessions
UNION ALL SELECT 'health_measurements', COUNT(*) FROM health_measurements
UNION ALL SELECT 'lab_values', COUNT(*) FROM lab_values
UNION ALL SELECT 'health_documents', COUNT(*) FROM health_documents
UNION ALL SELECT 'medication_history', COUNT(*) FROM medication_history
UNION ALL SELECT 'medications', COUNT(*) FROM medications
UNION ALL SELECT 'supplement_history', COUNT(*) FROM supplement_history
UNION ALL SELECT 'supplements', COUNT(*) FROM supplements
UNION ALL SELECT 'screenings', COUNT(*) FROM screenings
UNION ALL SELECT 'reminder_preferences', COUNT(*) FROM reminder_preferences
UNION ALL SELECT 'reminder_log', COUNT(*) FROM reminder_log
UNION ALL SELECT 'message_credit_transactions', COUNT(*) FROM message_credit_transactions
UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs
UNION ALL SELECT 'audit_logs (user_id set)', COUNT(*) FROM audit_logs WHERE user_id IS NOT NULL
UNION ALL SELECT 'ab_tests', COUNT(*) FROM ab_tests
UNION ALL SELECT 'ab_events', COUNT(*) FROM ab_events
ORDER BY 1;


-- ============================================================================
-- SECTION 2 — THE PURGE (single transaction; COMMIT is manual, see Section 3)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 2a. SCRUB profiles → pseudonymous anchors.
--     UPDATE, never DELETE: chat_conversations / chat_messages /
--     chat_match_events / guest_chat_sessions all FK these rows with
--     ON DELETE CASCADE — deleting a profile would silently eat its chat.
--     Excludes the shared Discord bot profile.
-- ---------------------------------------------------------------------------
UPDATE profiles
SET
  email                  = 'anon-' || id || '@deleted.invalid',  -- synthetic, keeps NOT NULL satisfied
  shopify_customer_id    = NULL,
  first_name             = NULL,
  last_name              = NULL,
  sex                    = NULL,   -- demographics
  birth_year             = NULL,
  birth_month            = NULL,
  height                 = NULL,
  unit_system            = NULL,
  unsubscribe_token      = NULL,   -- reminder-email capability token
  subscription_plan      = 'free', -- column DEFAULT (code reads it; NULL would be out-of-domain)
  subscription_id        = NULL,
  subscription_expires_at = NULL,
  subscription_checked_at = NULL,
  message_credits        = 0
WHERE id <> 'REPLACE_WITH_DISCORD_BOT_PROFILE_ID'::uuid;  -- DISCORD_BOT_PROFILE_ID exclusion

-- ---------------------------------------------------------------------------
-- 2b. ANONYMIZE chat tables — zero rows deleted, content + pseudonymous
--     tokens kept. chat_conversations needs no scrub (title is content;
--     external_id is a pseudonymous platform id and is kept).
-- ---------------------------------------------------------------------------

-- chat_messages: raw error text can embed request/identity fragments.
-- content, role, tokens, model, is_fallback, failure_mode, discord_message_id all kept.
UPDATE chat_messages
SET error_detail = NULL
WHERE error_detail IS NOT NULL;

-- chat_match_events: router_error is the same class of raw error text as
-- chat_messages.error_detail. message / router_context / router_raw /
-- matched_handles are content + telemetry — kept.
UPDATE chat_match_events
SET router_error = NULL
WHERE router_error IS NOT NULL;

-- guest_chat_sessions: ip_address is NOT NULL, so overwrite instead of NULL.
-- session_token (pseudonymous) and created_at kept; rows NOT deleted — they
-- anchor guest chat history via profiles(id).
UPDATE guest_chat_sessions
SET ip_address = '0.0.0.0'
WHERE ip_address <> '0.0.0.0';

-- ---------------------------------------------------------------------------
-- 2c. DELETE per-user health data — all rows, child/history tables first.
--     Every table FKs profiles (kept), so no cascades fire; each DELETE is
--     explicit. Order is FK-safe: history/log tables before their parents.
-- ---------------------------------------------------------------------------

DELETE FROM medication_history;          -- DESTRUCTIVE: all medication change history
DELETE FROM medications;                 -- DESTRUCTIVE: all current medications
DELETE FROM supplement_history;          -- DESTRUCTIVE: all supplement change history
DELETE FROM supplements;                 -- DESTRUCTIVE: all current supplements
DELETE FROM health_measurements;         -- DESTRUCTIVE: all time-series metrics (self-FK corrects_id is intra-table; full delete is safe)
DELETE FROM lab_values;                  -- DESTRUCTIVE: all free-form lab results
DELETE FROM health_documents;            -- DESTRUCTIVE: all uploaded document content/metadata
DELETE FROM screenings;                  -- DESTRUCTIVE: all screening records
DELETE FROM reminder_preferences;        -- DESTRUCTIVE: all per-category reminder opt-outs (v1 cron retired in same change-set)
DELETE FROM reminder_log;                -- DESTRUCTIVE: all reminder cooldown rows (v1 cron retired in same change-set)
DELETE FROM message_credit_transactions; -- DESTRUCTIVE: all credit purchase/spend audit rows (balances already zeroed in 2a)

-- ---------------------------------------------------------------------------
-- 2d. ANONYMIZE audit_logs — keep the operational record, sever the user link.
--     Rows are NOT deleted.
-- ---------------------------------------------------------------------------
UPDATE audit_logs
SET user_id = NULL
WHERE user_id IS NOT NULL;


-- ============================================================================
-- SECTION 3 — IN-TRANSACTION SANITY CHECK, then COMMIT or ROLLBACK.
-- Run this WHILE the transaction is still open.
-- ============================================================================

SELECT 'profiles' AS tbl, COUNT(*) FROM profiles
UNION ALL SELECT 'chat_conversations', COUNT(*) FROM chat_conversations
UNION ALL SELECT 'chat_messages', COUNT(*) FROM chat_messages
UNION ALL SELECT 'chat_match_events', COUNT(*) FROM chat_match_events
UNION ALL SELECT 'guest_chat_sessions', COUNT(*) FROM guest_chat_sessions
UNION ALL SELECT 'health_measurements', COUNT(*) FROM health_measurements
UNION ALL SELECT 'lab_values', COUNT(*) FROM lab_values
UNION ALL SELECT 'health_documents', COUNT(*) FROM health_documents
UNION ALL SELECT 'medication_history', COUNT(*) FROM medication_history
UNION ALL SELECT 'medications', COUNT(*) FROM medications
UNION ALL SELECT 'supplement_history', COUNT(*) FROM supplement_history
UNION ALL SELECT 'supplements', COUNT(*) FROM supplements
UNION ALL SELECT 'screenings', COUNT(*) FROM screenings
UNION ALL SELECT 'reminder_preferences', COUNT(*) FROM reminder_preferences
UNION ALL SELECT 'reminder_log', COUNT(*) FROM reminder_log
UNION ALL SELECT 'message_credit_transactions', COUNT(*) FROM message_credit_transactions
UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs
UNION ALL SELECT 'audit_logs (user_id set)', COUNT(*) FROM audit_logs WHERE user_id IS NOT NULL
UNION ALL SELECT 'ab_tests', COUNT(*) FROM ab_tests
UNION ALL SELECT 'ab_events', COUNT(*) FROM ab_events
ORDER BY 1;

-- CHECKLIST before committing — compare against the Section 1 numbers:
--   [ ] profiles            count UNCHANGED (rows scrubbed, not deleted)
--   [ ] chat_conversations  count UNCHANGED
--   [ ] chat_messages       count UNCHANGED
--   [ ] chat_match_events   count UNCHANGED
--   [ ] guest_chat_sessions count UNCHANGED
--   [ ] ab_tests / ab_events counts UNCHANGED
--   [ ] audit_logs total    count UNCHANGED; "(user_id set)" now 0
--   [ ] all 11 health tables now 0
--
-- If ANY keep-table count changed:  ROLLBACK;
--
-- If everything matches, uncomment and run:
-- COMMIT;


-- ============================================================================
-- SECTION 4 — VERIFY AFTER COMMIT
-- ============================================================================

-- 4a. No real identity left on profiles (expect 0; Discord bot row keeps its
--     synthetic identity and is excluded here too):
SELECT COUNT(*) AS profiles_with_identity
FROM profiles
WHERE id <> 'REPLACE_WITH_DISCORD_BOT_PROFILE_ID'::uuid
  AND (email NOT LIKE 'anon-%@deleted.invalid'
       OR shopify_customer_id IS NOT NULL
       OR first_name IS NOT NULL OR last_name IS NOT NULL
       OR sex IS NOT NULL OR birth_year IS NOT NULL OR birth_month IS NOT NULL
       OR height IS NOT NULL OR unit_system IS NOT NULL
       OR unsubscribe_token IS NOT NULL
       OR subscription_id IS NOT NULL
       OR message_credits <> 0);

-- 4b. Chat scrub complete (all expect 0):
SELECT
  (SELECT COUNT(*) FROM chat_messages WHERE error_detail IS NOT NULL)      AS msgs_with_error_detail,
  (SELECT COUNT(*) FROM chat_match_events WHERE router_error IS NOT NULL)  AS events_with_router_error,
  (SELECT COUNT(*) FROM guest_chat_sessions WHERE ip_address <> '0.0.0.0') AS sessions_with_real_ip,
  (SELECT COUNT(*) FROM audit_logs WHERE user_id IS NOT NULL)              AS audit_rows_still_linked;

-- 4c. Chat content survived — spot-check a few conversations end-to-end:
SELECT c.id, c.platform, c.external_id, COUNT(m.id) AS messages
FROM chat_conversations c
LEFT JOIN chat_messages m ON m.conversation_id = c.id
GROUP BY c.id, c.platform, c.external_id
ORDER BY MAX(m.created_at) DESC NULLS LAST
LIMIT 10;

-- ===========================================================================
-- 5. OPTIONAL (RECOMMENDED) — scrub plaintext emails from Supabase auth.
-- ===========================================================================
-- Brad confirmed (2026-06-12): scrub the emails but KEEP the rows. This is SAFE
-- for chat history — the chat tables FK to profiles.id → auth.users.id, i.e. they
-- depend on the ROW ID, not the email. Changing the email column leaves the id +
-- row intact, so nothing cascades and no chat is lost. Password hashes
-- (encrypted_password) are left as-is (bcrypt, harmless).
--
-- The email is duplicated in TWO places for email/password users, so scrub both:
--   (a) auth.users.email
--   (b) auth.identities.identity_data->>'email'
-- Run with the service role / a direct DB connection (the `auth` schema is not
-- exposed via the anon API). Excludes the Discord bot. Synthetic emails are keyed
-- by id so the UNIQUE(email) constraint is preserved.
--
-- Run this INSIDE the same transaction as section 3, BEFORE the COMMIT, OR as a
-- separate deliberate pass — either is safe. To skip it (leave auth fully
-- untouched), simply don't run this section.

UPDATE auth.users
SET email                  = 'anon-' || id || '@deleted.invalid',
    email_change           = NULL,
    email_change_token_new = NULL,
    email_change_token_current = NULL,
    phone                  = NULL,
    raw_user_meta_data     = '{}'::jsonb   -- may echo name/email from signup
WHERE id <> '<<REPLACE_WITH_DISCORD_BOT_PROFILE_ID>>'::uuid;

UPDATE auth.identities
SET identity_data = jsonb_set(
      jsonb_set(identity_data, '{email}', to_jsonb('anon-' || user_id || '@deleted.invalid')),
      '{email_verified}', 'false'::jsonb)
WHERE user_id <> '<<REPLACE_WITH_DISCORD_BOT_PROFILE_ID>>'::uuid
  AND identity_data ? 'email';

-- VERIFY: no real-looking emails remain (should return only anon-…@deleted.invalid
-- plus the Discord bot row).
-- SELECT email FROM auth.users WHERE email NOT LIKE 'anon-%@deleted.invalid' LIMIT 20;
