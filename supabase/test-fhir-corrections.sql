-- Negative-test suite for the FHIR replaces pattern (May 2026 redesign).
-- Spec: docs/lab-upload-redesign.html §11
--
-- Run this on staging Supabase AFTER applying rls-policies.sql.
-- Each block:
--   (a) sets up test data,
--   (b) executes the attack/edge case,
--   (c) raises a NOTICE if behaviour matches the spec,
--   (d) RAISE EXCEPTION if behaviour deviates.
-- Wrapped in a transaction and rolled back at the end so staging stays clean.
--
-- Run via: psql or Supabase Dashboard SQL Editor.

BEGIN;

DO $$
DECLARE
  user_a UUID := gen_random_uuid();
  user_b UUID := gen_random_uuid();
  row_id UUID;
  corrector_id UUID;
  rows_affected INTEGER;
  err_msg TEXT;
  caught BOOLEAN;
BEGIN
  -- =========================================================================
  -- SETUP: insert two fake auth.users rows + their profile shells so the
  -- FK constraints on health_measurements pass.
  --
  -- Note: we go through profiles directly with the service role context.
  -- The handle_new_user() trigger normally creates profiles; we bypass it.
  -- =========================================================================
  INSERT INTO auth.users (id, email, instance_id)
    VALUES (user_a, 'a@test.local', '00000000-0000-0000-0000-000000000000'),
           (user_b, 'b@test.local', '00000000-0000-0000-0000-000000000000');
  -- profiles rows auto-created by trigger handle_new_user()

  -- =========================================================================
  -- TEST 1: happy path. Insert active row, call correct_measurement,
  -- verify (a) new active row exists with corrects_id set, (b) old row
  -- has status='entered-in-error'.
  -- =========================================================================
  INSERT INTO public.health_measurements
    (user_id, metric_type, value, recorded_at, source)
    VALUES (user_a, 'apob', 0.79, NOW(), 'lab_import')
    RETURNING id INTO row_id;

  -- Simulate auth.uid() = user_a via SET LOCAL role + jwt.claims.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', user_a::text)::text, true);

  corrector_id := correct_measurement(row_id, 0.50, NULL);

  -- Verify new row
  IF NOT EXISTS (
    SELECT 1 FROM public.health_measurements
    WHERE id = corrector_id
      AND value = 0.50
      AND status = 'active'
      AND corrects_id = row_id
      AND source = 'manual_correction'
  ) THEN
    RAISE EXCEPTION 'TEST 1 FAIL: corrector row missing or wrong fields';
  END IF;

  -- Verify old row
  IF NOT EXISTS (
    SELECT 1 FROM public.health_measurements
    WHERE id = row_id
      AND value = 0.79  -- old value untouched
      AND status = 'entered-in-error'
  ) THEN
    RAISE EXCEPTION 'TEST 1 FAIL: old row not flagged entered-in-error or value mutated';
  END IF;

  RAISE NOTICE 'TEST 1 PASS: happy-path correction';

  -- =========================================================================
  -- TEST 2: double-correction. Correcting an already-corrected (now
  -- entered-in-error) row must raise "not correctable".
  -- =========================================================================
  caught := false;
  BEGIN
    PERFORM correct_measurement(row_id, 0.45, NULL);
  EXCEPTION WHEN OTHERS THEN
    caught := true;
    IF SQLERRM != 'Measurement not found or not correctable' THEN
      RAISE EXCEPTION 'TEST 2 FAIL: unexpected error message: %', SQLERRM;
    END IF;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'TEST 2 FAIL: double-correction did not raise';
  END IF;
  RAISE NOTICE 'TEST 2 PASS: double-correction blocked';

  -- =========================================================================
  -- TEST 3: cross-user correction. user_b attempts to correct user_a's row.
  -- =========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', user_b::text)::text, true);

  -- Insert a fresh active row owned by user_a (for user_b to attack)
  INSERT INTO public.health_measurements
    (user_id, metric_type, value, recorded_at, source)
    VALUES (user_a, 'ldl', 2.8, NOW(), 'manual')
    RETURNING id INTO row_id;

  caught := false;
  BEGIN
    PERFORM correct_measurement(row_id, 99.0, NULL);
  EXCEPTION WHEN OTHERS THEN
    caught := true;
    IF SQLERRM != 'Measurement not found or not correctable' THEN
      RAISE EXCEPTION 'TEST 3 FAIL: unexpected error: %', SQLERRM;
    END IF;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'TEST 3 FAIL: cross-user correction was permitted';
  END IF;

  -- Verify user_a's row is untouched
  IF NOT EXISTS (
    SELECT 1 FROM public.health_measurements
    WHERE id = row_id AND value = 2.8 AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'TEST 3 FAIL: user_a row mutated by user_b attempt';
  END IF;
  RAISE NOTICE 'TEST 3 PASS: cross-user correction blocked, row untouched';

  -- =========================================================================
  -- TEST 4: trigger rejects column-changing UPDATE. As table owner (post-
  -- migration, no role has direct UPDATE grant -- but SECURITY DEFINER
  -- functions can bypass; this simulates such an escape attempt).
  -- =========================================================================
  caught := false;
  BEGIN
    UPDATE public.health_measurements
       SET value = 999, status = 'entered-in-error'
     WHERE id = row_id;
  EXCEPTION WHEN OTHERS THEN
    caught := true;
    IF position('append-only' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'TEST 4 FAIL: unexpected error: %', SQLERRM;
    END IF;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'TEST 4 FAIL: column-changing UPDATE was permitted';
  END IF;
  -- Confirm row is still untouched
  IF NOT EXISTS (
    SELECT 1 FROM public.health_measurements
    WHERE id = row_id AND value = 2.8 AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'TEST 4 FAIL: row was mutated despite trigger';
  END IF;
  RAISE NOTICE 'TEST 4 PASS: trigger rejected column-change';

  -- =========================================================================
  -- TEST 5: trigger rejects status reversion. First flip to entered-in-error
  -- via the RPC, then attempt to flip back to active.
  -- =========================================================================
  PERFORM set_config('request.jwt.claims', json_build_object('sub', user_a::text)::text, true);
  corrector_id := correct_measurement(row_id, 2.5, NULL);

  caught := false;
  BEGIN
    UPDATE public.health_measurements
       SET status = 'active'
     WHERE id = row_id;
  EXCEPTION WHEN OTHERS THEN
    caught := true;
    IF position('reverted' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'TEST 5 FAIL: unexpected error: %', SQLERRM;
    END IF;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'TEST 5 FAIL: status reversion was permitted';
  END IF;
  RAISE NOTICE 'TEST 5 PASS: status reversion blocked';

  -- =========================================================================
  -- TEST 6: forged corrects_id. INSERT a row with corrects_id pointing
  -- at user_a's row, but row.user_id is user_b. Should be rejected by the
  -- BEFORE INSERT trigger.
  -- =========================================================================
  caught := false;
  BEGIN
    INSERT INTO public.health_measurements
      (user_id, metric_type, value, recorded_at, source, corrects_id)
      VALUES (user_b, 'apob', 0.5, NOW(), 'manual_correction', row_id);
  EXCEPTION WHEN OTHERS THEN
    caught := true;
    IF position('same user' in SQLERRM) = 0 THEN
      RAISE EXCEPTION 'TEST 6 FAIL: unexpected error: %', SQLERRM;
    END IF;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'TEST 6 FAIL: forged corrects_id was permitted';
  END IF;
  RAISE NOTICE 'TEST 6 PASS: forged corrects_id blocked';

  -- =========================================================================
  -- TEST 7: ON DELETE SET NULL. Hard-delete an entered-in-error row; the
  -- corrector's corrects_id should become NULL.
  -- =========================================================================
  -- row_id is entered-in-error (from test 5). corrector_id points at it.
  DELETE FROM public.health_measurements WHERE id = row_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.health_measurements
    WHERE id = corrector_id AND corrects_id IS NULL
  ) THEN
    RAISE EXCEPTION 'TEST 7 FAIL: corrects_id was not nulled on hard-delete';
  END IF;
  RAISE NOTICE 'TEST 7 PASS: ON DELETE SET NULL works (audit chain broken explicitly)';

  -- =========================================================================
  -- TEST 8: concurrent corrections (simulated). Two SELECTs that "see"
  -- status='active' followed by parallel UPDATEs. We can't truly fork
  -- transactions in a single DO block, but we can verify the lock-and-check
  -- pattern by attempting two corrections in sequence where the second
  -- attempts to correct an already-corrected row.
  --
  -- True parallel-execution test is in the Vitest integration suite
  -- (Promise.all of two correct_measurement calls).
  -- =========================================================================
  INSERT INTO public.health_measurements
    (user_id, metric_type, value, recorded_at, source)
    VALUES (user_a, 'hdl', 1.5, NOW(), 'manual')
    RETURNING id INTO row_id;

  PERFORM correct_measurement(row_id, 1.6, NULL);

  caught := false;
  BEGIN
    PERFORM correct_measurement(row_id, 1.7, NULL);
  EXCEPTION WHEN OTHERS THEN
    caught := true;
  END;
  IF NOT caught THEN
    RAISE EXCEPTION 'TEST 8 FAIL: second correction succeeded when first already flagged the row';
  END IF;
  RAISE NOTICE 'TEST 8 PASS: serialised correction (in-sequence race proxy)';

  -- =========================================================================
  -- TEST 9: trigger fires even on direct UPDATE that only touches status
  -- correctly. The forward transition (active -> entered-in-error) should
  -- be allowed. (Negative-case sanity check on the trigger.)
  -- =========================================================================
  INSERT INTO public.health_measurements
    (user_id, metric_type, value, recorded_at, source)
    VALUES (user_a, 'psa', 1.2, NOW(), 'manual')
    RETURNING id INTO row_id;

  -- Direct status flip (as table owner -- not normally available to users)
  UPDATE public.health_measurements SET status = 'entered-in-error' WHERE id = row_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.health_measurements
    WHERE id = row_id AND status = 'entered-in-error' AND value = 1.2
  ) THEN
    RAISE EXCEPTION 'TEST 9 FAIL: legitimate status flip was blocked or row mutated';
  END IF;
  RAISE NOTICE 'TEST 9 PASS: legitimate status-only UPDATE allowed';

  RAISE NOTICE '====================================';
  RAISE NOTICE 'ALL 9 TESTS PASSED';
  RAISE NOTICE '====================================';
END $$;

-- Roll back -- this is a test, no data should persist on staging.
ROLLBACK;
