-- ============================================================================
-- ONE-OFF CLEANUP — audit_logs identifiers and v1 metadata (US-15 AC50)
-- ============================================================================
-- Run by hand in the Supabase SQL Editor. Idempotent: a second run changes
-- nothing. The editor sends each run as one request, so a transaction never
-- survives from one run to the next: section 2 is a single run that opens,
-- cleans, checks and closes its own transaction.
--
-- The June 2026 purge (data-purge-2026-06.sql step 2d) nulled only
-- audit_logs.user_id. This script clears what that step did not touch:
--   USER_CREATED          resource_id = the profile id, metadata.shopifyCustomerId
--   GUEST_SESSION_CREATED metadata.ip (rows written 2026-04-02 to 2026-09-10)
--   v1 health-record actions, whose metadata names medicines, supplements,
--   doses, documents (a title can carry a name), lab metrics and screenings.
-- No code reads any of it: the only audit_logs read (supabase.server.ts) is
-- PAID_ORDER_UNPROVEN_LINK by order id. Counts by action and date are kept.
-- What may stay: the keys in the allow-list in step 2c, today's operational
-- metadata (CHAT_MESSAGE token counts, MESSAGE_CREDITS_PURCHASED amounts).

-- ---------------------------------------------------------------------------
-- 1. LOOK FIRST (read only). Every metadata key, by action.
-- ---------------------------------------------------------------------------
SELECT action, k AS key, count(*) AS rows
FROM audit_logs,
     jsonb_object_keys(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) k
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT
  (SELECT count(*) FROM audit_logs WHERE metadata IS NOT NULL AND jsonb_typeof(metadata) <> 'object') AS non_object_metadata,
  (SELECT count(*) FROM audit_logs WHERE action = 'USER_CREATED' AND user_id IS NULL AND resource_id IS NOT NULL) AS unlinked_user_created_with_profile_id,
  (SELECT count(*) FROM audit_logs) AS total_rows;

-- ---------------------------------------------------------------------------
-- 2. CLEAN AND CHECK — paste 2a to 2d as ONE run.
--    First run: leave 2d as ROLLBACK and read the counts from 2c.
--    Then run the same block again with 2d changed to COMMIT.
--    If 2c finds a key outside the allow-list it raises an error, the
--    transaction aborts, and nothing is written, even on the COMMIT run.
-- ---------------------------------------------------------------------------
BEGIN;

-- 2a. v1 health-record actions and identity actions: drop the metadata whole.
UPDATE audit_logs SET metadata = NULL
WHERE metadata IS NOT NULL
  AND action IN ('USER_CREATED', 'GUEST_SESSION_CREATED',
                 'MEDICATION_UPDATED', 'SUPPLEMENT_UPDATED', 'SUPPLEMENT_STOPPED',
                 'DOCUMENT_CREATED', 'LAB_VALUES_CREATED',
                 'MEASUREMENT_CREATED', 'MEASUREMENT_CORRECTED',
                 'SCREENING_UPDATED', 'PROFILE_UPDATED');

-- 2b. Any other row: drop an identifier key, keep the rest.
UPDATE audit_logs SET metadata = NULLIF(metadata - 'ip' - 'shopifyCustomerId', '{}'::jsonb)
WHERE jsonb_typeof(metadata) = 'object' AND metadata ?| ARRAY['ip', 'shopifyCustomerId'];
-- (A non-object metadata value is left for 2c to report, never guessed at.)

UPDATE audit_logs SET resource_id = NULL
WHERE action = 'USER_CREATED' AND user_id IS NULL AND resource_id IS NOT NULL;

-- 2c. CHECK: every key left is on the allow-list, and nothing else is left.
DO $$
DECLARE stray text;
BEGIN
  SELECT string_agg(DISTINCT a.action || '.' || k, ', ') INTO stray
  FROM audit_logs a,
       jsonb_object_keys(CASE WHEN jsonb_typeof(a.metadata) = 'object' THEN a.metadata ELSE '{}'::jsonb END) k
  WHERE (a.action, k) NOT IN (VALUES
      ('CHAT_MESSAGE', 'cacheRead'),
      ('CHAT_MESSAGE', 'cacheCreation'),
      ('MESSAGE_CREDITS_PURCHASED', 'amount'),
      ('MESSAGE_CREDITS_PURCHASED', 'variantId'),
      ('MESSAGE_CREDITS_PURCHASED', 'newBalance'));
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs keys outside the allow-list: %', stray;
  END IF;
  IF EXISTS (SELECT 1 FROM audit_logs WHERE metadata IS NOT NULL AND jsonb_typeof(metadata) <> 'object') THEN
    RAISE EXCEPTION 'audit_logs rows with non-object metadata remain';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_logs WHERE action = 'USER_CREATED' AND user_id IS NULL AND resource_id IS NOT NULL) THEN
    RAISE EXCEPTION 'unlinked USER_CREATED rows still carry a profile id';
  END IF;
END $$;

SELECT
  (SELECT count(*) FROM audit_logs WHERE metadata IS NOT NULL) AS rows_with_metadata,
  (SELECT count(*) FROM audit_logs) AS total_rows;

-- 2d. ROLLBACK on the first run; COMMIT on the second.
ROLLBACK;
