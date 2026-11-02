-- ============================================================================
-- ONE-OFF CLEANUP — audit_logs identifiers the June 2026 purge left behind
-- US-15 AC49, GHSA-w5p5-hmp4-7qmp. NOT RUN. Brad runs it, by hand, in the
-- Supabase SQL Editor, one section at a time. Idempotent: a second run
-- changes nothing.
-- ============================================================================
-- The purge (data-purge-2026-06.sql step 2d) only nulled audit_logs.user_id.
-- Two kinds of row still re-link a kept pseudonymous profile:
--   USER_CREATED          resource_id = the profile id, metadata.shopifyCustomerId
--                         = the Shopify customer (written until this change).
--   GUEST_SESSION_CREATED metadata.ip = the raw caller IP, resource_id = the
--                         guest session id = the guest profile id (written
--                         2026-04-02 to 2026-09-10).
-- No code reads either key or these resource_ids: the only audit_logs read
-- (supabase.server.ts) is PAID_ORDER_UNPROVEN_LINK by order id. The issue #309
-- diagnosis counted USER_CREATED rows by action and date, which this keeps.

-- 1. COUNT FIRST (read only).
SELECT
  (SELECT count(*) FROM audit_logs WHERE action = 'USER_CREATED' AND metadata ? 'shopifyCustomerId') AS user_created_with_customer_id,
  (SELECT count(*) FROM audit_logs WHERE action = 'USER_CREATED' AND user_id IS NULL AND resource_id IS NOT NULL) AS user_created_unlinked_with_profile_id,
  (SELECT count(*) FROM audit_logs WHERE metadata ? 'ip') AS rows_with_ip,
  (SELECT count(*) FROM audit_logs) AS total_rows;

-- 2. CLEAN, in one transaction.
BEGIN;

UPDATE audit_logs SET metadata = NULLIF(metadata - 'shopifyCustomerId', '{}'::jsonb)
WHERE action = 'USER_CREATED' AND metadata ? 'shopifyCustomerId';

UPDATE audit_logs SET resource_id = NULL
WHERE action = 'USER_CREATED' AND user_id IS NULL AND resource_id IS NOT NULL;

UPDATE audit_logs SET metadata = NULLIF(metadata - 'ip', '{}'::jsonb)
WHERE metadata ? 'ip';

-- 3. CHECK inside the transaction. Expect 0, 0, and total_rows unchanged.
SELECT
  (SELECT count(*) FROM audit_logs WHERE metadata ? 'shopifyCustomerId' OR metadata ? 'ip') AS identifiers_left,
  (SELECT count(*) FROM audit_logs WHERE action = 'USER_CREATED' AND user_id IS NULL AND resource_id IS NOT NULL) AS unlinked_profile_ids_left,
  (SELECT count(*) FROM audit_logs) AS total_rows;

-- 4. Then one of:
-- COMMIT;
-- ROLLBACK;
