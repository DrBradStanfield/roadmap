-- Supabase RLS Policies for Health Roadmap Tool
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
--
-- RLS is enforced at the database level. The app uses:
--   - Service key (supabaseAdmin) for user creation and profile lookups only
--   - Anon key + custom JWT (createUserClient) for all data queries
-- RLS policies use auth.uid() to scope every query to the authenticated user.

-- ===== Create profiles table =====

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shopify_customer_id TEXT,  -- nullable for mobile-only users without Shopify accounts
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===== Add demographic columns to profiles =====

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sex INTEGER CHECK (sex IN (1, 2));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS birth_year INTEGER CHECK (birth_year BETWEEN 1900 AND 2100);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS unit_system INTEGER CHECK (unit_system IN (1, 2));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS height NUMERIC CHECK (height BETWEEN 50 AND 250);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS welcome_email_sent BOOLEAN DEFAULT FALSE;

-- ===== Create health_measurements table =====
-- Only health metrics — demographics are on the profiles table.

CREATE TABLE IF NOT EXISTS health_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'weight', 'waist',
    'hba1c', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides',
    'systolic_bp', 'diastolic_bp', 'apob', 'creatinine', 'psa', 'lpa'
  )),
  value NUMERIC NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT value_range CHECK (
    CASE metric_type
      WHEN 'weight'          THEN value BETWEEN 20 AND 300
      WHEN 'waist'           THEN value BETWEEN 40 AND 200
      WHEN 'hba1c'           THEN value BETWEEN 9 AND 195
      WHEN 'ldl'             THEN value BETWEEN 0 AND 12.9
      WHEN 'total_cholesterol' THEN value BETWEEN 0 AND 15
      WHEN 'hdl'             THEN value BETWEEN 0 AND 5.2
      WHEN 'triglycerides'   THEN value BETWEEN 0 AND 22.6
      WHEN 'systolic_bp'     THEN value BETWEEN 60 AND 250
      WHEN 'diastolic_bp'    THEN value BETWEEN 40 AND 150
      WHEN 'apob'            THEN value BETWEEN 0 AND 3
      WHEN 'creatinine'      THEN value BETWEEN 10 AND 2650
      WHEN 'psa'             THEN value BETWEEN 0 AND 100
      WHEN 'lpa'             THEN value BETWEEN 0 AND 750
      ELSE false
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_measurements_user_type_date
  ON health_measurements(user_id, metric_type, recorded_at DESC);

-- ===== Add FHIR/HealthKit future-proofing columns to health_measurements =====
-- source: tracks where the measurement came from (manual entry, Apple HealthKit, etc.)
-- external_id: unique ID from external system (e.g. HealthKit sample UUID) for deduplication

ALTER TABLE health_measurements ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
ALTER TABLE health_measurements ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_measurements_external_id
  ON health_measurements(external_id) WHERE external_id IS NOT NULL;

-- ===== Migrate constraints for existing tables =====
-- CREATE TABLE IF NOT EXISTS is a no-op on existing tables, so constraints
-- must be updated via ALTER TABLE to add new metric types (e.g. apob).

ALTER TABLE health_measurements DROP CONSTRAINT IF EXISTS health_measurements_metric_type_check;
ALTER TABLE health_measurements ADD CONSTRAINT health_measurements_metric_type_check
  CHECK (metric_type IN (
    'weight', 'waist',
    'hba1c', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides',
    'systolic_bp', 'diastolic_bp', 'apob', 'creatinine', 'psa', 'lpa'
  ));

ALTER TABLE health_measurements DROP CONSTRAINT IF EXISTS value_range;
ALTER TABLE health_measurements ADD CONSTRAINT value_range CHECK (
  CASE metric_type
    WHEN 'weight'          THEN value BETWEEN 20 AND 300
    WHEN 'waist'           THEN value BETWEEN 40 AND 200
    WHEN 'hba1c'           THEN value BETWEEN 9 AND 195
    WHEN 'ldl'             THEN value BETWEEN 0 AND 12.9
    WHEN 'total_cholesterol' THEN value BETWEEN 0 AND 15
    WHEN 'hdl'             THEN value BETWEEN 0 AND 5.2
    WHEN 'triglycerides'   THEN value BETWEEN 0 AND 22.6
    WHEN 'systolic_bp'     THEN value BETWEEN 60 AND 250
    WHEN 'diastolic_bp'    THEN value BETWEEN 40 AND 150
    WHEN 'apob'            THEN value BETWEEN 0 AND 3
    WHEN 'creatinine'      THEN value BETWEEN 10 AND 2650
    WHEN 'psa'             THEN value BETWEEN 0 AND 100
    WHEN 'lpa'             THEN value BETWEEN 0 AND 750
    ELSE false
  END
);

-- ===== Trigger: auto-create profile when Supabase Auth user is created =====

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, shopify_customer_id, email)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'shopify_customer_id',
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===== Unique constraint on shopify_customer_id =====
-- Ensure shopify_customer_id is nullable (required for guest profiles which have no Shopify account).
-- The CREATE TABLE definition already specifies TEXT (nullable), but an earlier migration may have
-- added NOT NULL. This fixes it. NULLs are allowed by PostgreSQL UNIQUE constraints.
ALTER TABLE profiles ALTER COLUMN shopify_customer_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_shopify_customer_id_unique'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_shopify_customer_id_unique
      UNIQUE (shopify_customer_id);
  END IF;
END $$;

-- ===== RPC for efficient "latest per metric" query =====
-- Uses auth.uid() so it works with RLS on the anon key.
-- Returns only health metrics (not demographics, which live on profiles).
-- DROP first because changing RETURNS TABLE columns requires it (Postgres can't ALTER return type).

DROP FUNCTION IF EXISTS get_latest_measurements();
DROP FUNCTION IF EXISTS get_latest_measurements(uuid);  -- clean up old overload
CREATE OR REPLACE FUNCTION get_latest_measurements()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  metric_type TEXT,
  value NUMERIC,
  recorded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  source TEXT,
  external_id TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (m.metric_type)
    m.id,
    m.user_id,
    m.metric_type,
    m.value,
    m.recorded_at,
    m.created_at,
    m.source,
    m.external_id
  FROM public.health_measurements m
  WHERE m.user_id = auth.uid()
    AND m.status = 'active'  -- exclude entered-in-error rows
  ORDER BY m.metric_type, m.recorded_at DESC;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Grant execute to authenticated role so custom JWT users can call this RPC
GRANT EXECUTE ON FUNCTION get_latest_measurements() TO authenticated;

-- ===== Drop previous policies =====

DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can read own measurements" ON health_measurements;
DROP POLICY IF EXISTS "Users can insert own measurements" ON health_measurements;
DROP POLICY IF EXISTS "Users can delete own measurements" ON health_measurements;

-- ===== Enable RLS =====

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_measurements ENABLE ROW LEVEL SECURITY;

-- ===== Profiles policies =====

CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (id = auth.uid());

-- ===== Health measurements policies =====
-- No UPDATE policy — records are immutable (Apple Health model: delete + re-add).

CREATE POLICY "Users can read own measurements"
  ON health_measurements FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own measurements"
  ON health_measurements FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own measurements"
  ON health_measurements FOR DELETE
  USING (user_id = auth.uid());

-- ===== Table grants for authenticated role =====
-- Explicit grants ensure the authenticated role can access tables after DROP/CREATE.
-- Without these, the anon key + custom JWT client silently fails.

GRANT SELECT, UPDATE ON profiles TO authenticated;
GRANT SELECT, INSERT, DELETE ON health_measurements TO authenticated;

-- ============================================================
-- FHIR `replaces` pattern for measurement corrections
-- ============================================================
-- Rows are physically immutable except for a single status transition
-- (active -> entered-in-error). All corrections go through the
-- correct_measurement() SECURITY DEFINER RPC; there is no user-facing
-- UPDATE pathway. See docs/lab-upload-redesign.html for full design.

ALTER TABLE health_measurements
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'entered-in-error'));

-- ON DELETE SET NULL: if a referenced entered-in-error row is hard-deleted,
-- the corrector's link is nulled rather than cascading. Audit mode then
-- renders the corrector with no "replaces" arrow.
ALTER TABLE health_measurements
  ADD COLUMN IF NOT EXISTS corrects_id UUID
    REFERENCES health_measurements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_measurements_user_active
  ON health_measurements(user_id, metric_type, recorded_at DESC)
  WHERE status = 'active';

-- No user-facing UPDATE: the RPC below is the only writer. Idempotent
-- REVOKE makes the no-UPDATE rule self-documenting.
REVOKE UPDATE ON health_measurements FROM authenticated;

-- to_jsonb(NEW) - 'status' is schema-evolution-resilient: any column added
-- later to health_measurements is automatically locked down.
CREATE OR REPLACE FUNCTION enforce_measurement_correction_only()
RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'health_measurements is append-only; only status may change (via correct_measurement RPC)';
  END IF;
  -- entered-in-error is sticky
  IF OLD.status = 'entered-in-error' AND NEW.status != 'entered-in-error' THEN
    RAISE EXCEPTION 'status cannot be reverted from entered-in-error';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS trg_measurement_correction_only ON health_measurements;
CREATE TRIGGER trg_measurement_correction_only
  BEFORE UPDATE ON health_measurements
  FOR EACH ROW EXECUTE FUNCTION enforce_measurement_correction_only();

CREATE OR REPLACE FUNCTION validate_corrects_id_ownership()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.corrects_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.health_measurements
      WHERE id = NEW.corrects_id AND user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'corrects_id must reference a row owned by the same user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS trg_validate_corrects_id ON health_measurements;
CREATE TRIGGER trg_validate_corrects_id
  BEFORE INSERT ON health_measurements
  FOR EACH ROW EXECUTE FUNCTION validate_corrects_id_ownership();

-- UPDATE-first lock-and-check: serialises concurrent callers via row lock.
-- Without this, two parallel SELECT-then-UPDATE flows could both observe
-- status='active' under MVCC and produce two active replacements.
CREATE OR REPLACE FUNCTION correct_measurement(
  old_measurement_id UUID,
  new_value          NUMERIC,
  new_recorded_at    TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  -- Fully qualified because SET search_path = '' below requires every
  -- object reference (including row types) to be schema-prefixed.
  old_row       public.health_measurements%ROWTYPE;
  rows_affected INTEGER;
  new_id        UUID;
BEGIN
  UPDATE public.health_measurements
     SET status = 'entered-in-error'
   WHERE id = old_measurement_id
     AND user_id = auth.uid()
     AND status = 'active'
   RETURNING * INTO old_row;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  IF rows_affected = 0 THEN
    RAISE EXCEPTION 'Measurement not found or not correctable';
  END IF;

  BEGIN
    INSERT INTO public.health_measurements
      (user_id, metric_type, value, recorded_at, source, corrects_id)
    VALUES
      (old_row.user_id,
       old_row.metric_type,
       new_value,
       COALESCE(new_recorded_at, old_row.recorded_at),
       'manual_correction',
       old_measurement_id)
    RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent insert filled the (user, metric, recorded_at) slot
    -- between the UPDATE above and this INSERT (e.g. another tab uploading
    -- the same date). Postgres rolls back the whole RPC, so the UPDATE
    -- flip is also undone. Surface a specific, retriable error.
    RAISE EXCEPTION 'Conflict: another value was saved at this date while you were correcting. Refresh and try again.'
      USING ERRCODE = '23505';
  END;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

GRANT EXECUTE ON FUNCTION correct_measurement(UUID, NUMERIC, TIMESTAMPTZ) TO authenticated;

-- Two active rows must NOT share (user_id, metric_type, recorded_at).
-- Catches the case where the LLM extracts a lab report's "current + previous"
-- side-by-side columns, or where the same file is re-uploaded. The partial
-- WHERE clause means entered-in-error rows don't count, so the
-- correct_measurement() flip-then-insert sequence stays safe.
--
-- Multiple BP readings on the same day at different times are still allowed
-- (different recorded_at). Lab-upload always sets recorded_at to midnight UTC
-- of the day, so dupes within an upload share recorded_at exactly.

-- One-time data cleanup so the unique index can be created on existing data.
-- Real production data (pre-deploy) accumulated duplicates from the very bug
-- this index now prevents. Keep the newest row of each (user, metric,
-- recorded_at) group; flip older siblings to entered-in-error. Goes through
-- the existing enforce_measurement_correction_only trigger cleanly because
-- only status changes.
WITH duplicate_groups AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, metric_type, recorded_at
    ORDER BY created_at DESC
  ) AS rn
  FROM public.health_measurements
  WHERE status = 'active'
)
UPDATE public.health_measurements
   SET status = 'entered-in-error'
 WHERE id IN (SELECT id FROM duplicate_groups WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_measurements_user_metric_active
  ON public.health_measurements(user_id, metric_type, recorded_at)
  WHERE status = 'active';

-- ===== FHIR documentation (psql \d shows these) =====

COMMENT ON COLUMN public.health_measurements.status IS
  'FHIR R4 Observation status. Only ''active'' rows feed the latest-per-metric view. ''entered-in-error'' rows are kept for audit but invisible to suggestions. Mutated only by the correct_measurement() RPC.';

COMMENT ON COLUMN public.health_measurements.corrects_id IS
  'FHIR replaces link: when this row is a correction, points at the entered-in-error row it replaces. NULL on original inserts. Self-FK with ON DELETE SET NULL.';

COMMENT ON COLUMN public.health_measurements.source IS
  'Provenance enum: ''manual'', ''apple_health'', ''fitbit'', ''lab_import'', ''lab_import_edited'' (LLM-extracted then user-corrected at review time), ''manual_correction'' (inserted by correct_measurement RPC). Mirrored by MEASUREMENT_SOURCES in packages/health-core/src/validation.ts.';

COMMENT ON INDEX public.uniq_measurements_user_metric_active IS
  'Partial UNIQUE index: only ''active'' rows participate. Lets us hold many historical entered-in-error rows for the same (user, metric, recorded_at) while preventing two active rows. Violation surfaces as 23505 and is mapped to HTTP 409 ("Use the correction UI to update it.") by api.measurements.ts.';

COMMENT ON FUNCTION public.correct_measurement(UUID, NUMERIC, TIMESTAMPTZ) IS
  'FHIR replaces: atomically flip the old row''s status to ''entered-in-error'' and insert a new active row with source=''manual_correction'' and corrects_id pointing at the old row. UPDATE-first-then-INSERT serialises concurrent corrections via the row lock; if a parallel INSERT wins the UNIQUE slot, this RPC catches unique_violation, rolls back the status flip, and re-raises 23505. SECURITY DEFINER + WHERE user_id = auth.uid() enforce ownership.';

COMMENT ON FUNCTION public.enforce_measurement_correction_only() IS
  'BEFORE UPDATE trigger: rejects any column change other than status. Uses (to_jsonb(NEW) - ''status'') IS DISTINCT FROM (to_jsonb(OLD) - ''status'') so the check is schema-evolution-resilient. Also makes ''entered-in-error'' sticky — reverts to ''active'' are blocked.';

COMMENT ON FUNCTION public.validate_corrects_id_ownership() IS
  'BEFORE INSERT trigger: rejects any row whose corrects_id references a row owned by a different user. Closes the cross-user FK-forge gap that RLS alone can''t catch on insert.';

-- ===== Audit logs table =====
-- Tracks all write operations for HIPAA compliance.
-- Inserted by the service-role admin client server-side.
-- Users can read their own logs via RLS SELECT policy.

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,  -- nullable (anonymized after account deletion)
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_logs(user_id, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own audit logs" ON audit_logs;
CREATE POLICY "Users can read own audit logs"
  ON audit_logs FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON audit_logs TO authenticated;

-- ===== Create medications table =====
-- Tracks medication status for the cholesterol medication cascade.
-- FHIR-compatible structure with separate drug_name, dose_value, dose_unit columns.
-- Uses UPSERT pattern (mutable, not time-series).

CREATE TABLE IF NOT EXISTS medications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  medication_key TEXT NOT NULL CHECK (medication_key IN ('statin', 'ezetimibe', 'statin_escalation', 'pcsk9i')),
  drug_name TEXT,           -- e.g., 'atorvastatin', 'rosuvastatin', 'none', 'not_tolerated', 'yes', 'no'
  dose_value INTEGER,       -- e.g., 40, null for non-drug fields
  dose_unit TEXT,           -- e.g., 'mg', null for non-drug fields
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, medication_key)
);

-- Migration: Add new columns if table already exists
ALTER TABLE medications ADD COLUMN IF NOT EXISTS drug_name TEXT;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS dose_value INTEGER;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS dose_unit TEXT;

-- Migration: Change dose_value from INTEGER to NUMERIC for decimal doses (e.g. GLP-1: 2.5mg)
ALTER TABLE medications ALTER COLUMN dose_value TYPE NUMERIC USING dose_value::NUMERIC;

-- Migration: Handle old 'value' column from tier-based storage (if it exists)
DO $$
BEGIN
  -- Make value nullable so new inserts don't require it
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'medications' AND column_name = 'value') THEN
    ALTER TABLE medications ALTER COLUMN value DROP NOT NULL;
    -- Migrate old tier-based data to new FHIR-compatible columns
    UPDATE medications SET drug_name = value WHERE drug_name IS NULL AND value IS NOT NULL;
  END IF;
END $$;

-- ===== Add FHIR MedicationStatement future-proofing columns =====
-- status: FHIR-required field (currently medication state is encoded in drug_name)
-- started_at: when patient started the medication (for clinical context)

ALTER TABLE medications ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
  CHECK (status IN ('active', 'stopped', 'intended', 'not-taken', 'on-hold'));
ALTER TABLE medications ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- Update medication_key constraint to include all medication cascades
ALTER TABLE medications DROP CONSTRAINT IF EXISTS medications_medication_key_check;
ALTER TABLE medications ADD CONSTRAINT medications_medication_key_check
  CHECK (medication_key IN (
    -- Cholesterol medication cascade
    'statin', 'ezetimibe', 'statin_escalation', 'statin_increase', 'pcsk9i', 'bempedoic_acid',
    -- Weight & diabetes medication cascade
    'glp1', 'glp1_escalation', 'sglt2i', 'metformin'
  ));

CREATE INDEX IF NOT EXISTS idx_medications_user ON medications(user_id);

ALTER TABLE medications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own medications" ON medications;
CREATE POLICY "Users can read own medications"
  ON medications FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own medications" ON medications;
CREATE POLICY "Users can insert own medications"
  ON medications FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own medications" ON medications;
CREATE POLICY "Users can update own medications"
  ON medications FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own medications" ON medications;
CREATE POLICY "Users can delete own medications"
  ON medications FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON medications TO authenticated;

-- ===== Create screenings table =====
-- Tracks cancer screening status and last screening dates.
-- Uses UPSERT pattern (mutable, not time-series) — same as medications.

CREATE TABLE IF NOT EXISTS screenings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  screening_key TEXT NOT NULL CHECK (screening_key IN (
    'colorectal_method', 'colorectal_last_date',
    'colorectal_result', 'colorectal_followup_status', 'colorectal_followup_date',
    'breast_frequency', 'breast_last_date',
    'breast_result', 'breast_followup_status', 'breast_followup_date',
    'cervical_method', 'cervical_last_date',
    'cervical_result', 'cervical_followup_status', 'cervical_followup_date',
    'lung_smoking_history', 'lung_pack_years', 'lung_screening', 'lung_last_date',
    'lung_result', 'lung_followup_status', 'lung_followup_date',
    'prostate_discussion', 'prostate_psa_value', 'prostate_last_date',
    'endometrial_discussion', 'endometrial_abnormal_bleeding',
    'dexa_screening', 'dexa_last_date', 'dexa_result',
    'dexa_followup_status', 'dexa_followup_date'
  )),
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, screening_key)
);

CREATE INDEX IF NOT EXISTS idx_screenings_user ON screenings(user_id);

-- ===== Migrate screening_key constraint for existing tables =====
-- CREATE TABLE IF NOT EXISTS is a no-op on existing tables, so the CHECK
-- constraint must be updated via ALTER TABLE when new screening types are added.
ALTER TABLE screenings DROP CONSTRAINT IF EXISTS screenings_screening_key_check;
ALTER TABLE screenings ADD CONSTRAINT screenings_screening_key_check
  CHECK (screening_key IN (
    'colorectal_method', 'colorectal_last_date',
    'colorectal_result', 'colorectal_followup_status', 'colorectal_followup_date',
    'breast_frequency', 'breast_last_date',
    'breast_result', 'breast_followup_status', 'breast_followup_date',
    'cervical_method', 'cervical_last_date',
    'cervical_result', 'cervical_followup_status', 'cervical_followup_date',
    'lung_smoking_history', 'lung_pack_years', 'lung_screening', 'lung_last_date',
    'lung_result', 'lung_followup_status', 'lung_followup_date',
    'prostate_discussion', 'prostate_psa_value', 'prostate_last_date',
    'endometrial_discussion', 'endometrial_abnormal_bleeding',
    'dexa_screening', 'dexa_last_date', 'dexa_result',
    'dexa_followup_status', 'dexa_followup_date'
  ));

ALTER TABLE screenings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own screenings" ON screenings;
CREATE POLICY "Users can read own screenings"
  ON screenings FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own screenings" ON screenings;
CREATE POLICY "Users can insert own screenings"
  ON screenings FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own screenings" ON screenings;
CREATE POLICY "Users can update own screenings"
  ON screenings FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own screenings" ON screenings;
CREATE POLICY "Users can delete own screenings"
  ON screenings FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON screenings TO authenticated;

-- ===== Add reminder columns to profiles =====

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reminders_global_optout BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT;

-- ===== Create reminder_preferences table =====
-- Per-category opt-out for health reminder emails.
-- Default opt-in: if no row exists for a category, the user receives reminders.

CREATE TABLE IF NOT EXISTS reminder_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reminder_category TEXT NOT NULL CHECK (reminder_category IN (
    'screening_colorectal', 'screening_breast', 'screening_cervical',
    'screening_lung', 'screening_prostate', 'screening_dexa',
    'blood_test_lipids', 'blood_test_hba1c', 'blood_test_creatinine',
    'medication_review'
  )),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, reminder_category)
);

CREATE INDEX IF NOT EXISTS idx_reminder_prefs_user ON reminder_preferences(user_id);

ALTER TABLE reminder_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own reminder preferences" ON reminder_preferences;
CREATE POLICY "Users can read own reminder preferences"
  ON reminder_preferences FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own reminder preferences" ON reminder_preferences;
CREATE POLICY "Users can insert own reminder preferences"
  ON reminder_preferences FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own reminder preferences" ON reminder_preferences;
CREATE POLICY "Users can update own reminder preferences"
  ON reminder_preferences FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own reminder preferences" ON reminder_preferences;
CREATE POLICY "Users can delete own reminder preferences"
  ON reminder_preferences FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON reminder_preferences TO authenticated;

-- ===== Create reminder_log table =====
-- Tracks sent reminder emails per group to enforce cooldowns.
-- Only written by service role (cron job). Users can read their own logs.

CREATE TABLE IF NOT EXISTS reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reminder_group TEXT NOT NULL CHECK (reminder_group IN ('screening', 'blood_test', 'medication_review')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_eligible_at TIMESTAMPTZ NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminder_log_user_group
  ON reminder_log(user_id, reminder_group, next_eligible_at DESC);

ALTER TABLE reminder_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own reminder logs" ON reminder_log;
CREATE POLICY "Users can read own reminder logs"
  ON reminder_log FOR SELECT
  USING (user_id = auth.uid());

GRANT SELECT ON reminder_log TO authenticated;

-- ===== Admin RPC: latest measurement date per metric =====
-- Used by the reminder cron job (service role). Does NOT use auth.uid().
-- Uses the existing idx_measurements_user_type_date index.
DROP FUNCTION IF EXISTS get_latest_measurement_dates(UUID);
CREATE OR REPLACE FUNCTION get_latest_measurement_dates(target_user_id UUID)
RETURNS TABLE (metric_type TEXT, recorded_at TIMESTAMPTZ) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (m.metric_type) m.metric_type, m.recorded_at
  FROM public.health_measurements m
  WHERE m.user_id = target_user_id
    AND m.status = 'active'  -- reminders ignore corrected rows
  ORDER BY m.metric_type, m.recorded_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- ===== Cron lock table =====
-- Coordinates the reminder cron job across multiple Fly.io machines.
-- Atomic UPDATE ... WHERE lock_date != today ensures only one machine runs per day.
CREATE TABLE IF NOT EXISTS cron_lock (
  lock_name TEXT PRIMARY KEY,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  lock_date TEXT
);

-- lock_date is seeded with a sentinel past date (not NULL) because
-- `WHERE lock_date != today` evaluates to NULL on NULL rows (not true), so a
-- NULL seed would silently block lock acquisition.
INSERT INTO cron_lock (lock_name, locked_by, locked_at, lock_date)
VALUES ('reminder_cron', NULL, NULL, '1970-01-01')
ON CONFLICT DO NOTHING;

INSERT INTO cron_lock (lock_name, locked_by, locked_at, lock_date)
VALUES ('trending_cron', NULL, NULL, '1970-01-01')
ON CONFLICT DO NOTHING;

-- ===== Enable RLS on infrastructure tables =====
-- These tables have no user data and no policies (= zero rows via API).
-- cron_lock: accessed via service role (bypasses RLS)
-- shopify_sessions*: accessed via direct PostgreSQL connection (bypasses RLS)
ALTER TABLE cron_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS shopify_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS shopify_sessions_migrations ENABLE ROW LEVEL SECURITY;

-- ===== Create health_documents table =====
-- Stores uploaded health documents (scan results, clinic letters, etc.) as searchable markdown.
-- Immutable: no UPDATE policy. Delete + re-upload if incorrect.

CREATE TABLE IF NOT EXISTS health_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'scan_result', 'clinic_letter', 'discharge_summary',
    'pathology_report', 'vaccination_record', 'other'
  )),
  title TEXT NOT NULL,
  document_date DATE,
  content_md TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  source_file_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_health_documents_user_date
  ON health_documents(user_id, document_date DESC);

ALTER TABLE health_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own health documents" ON health_documents;
CREATE POLICY "Users can read own health documents"
  ON health_documents FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own health documents" ON health_documents;
CREATE POLICY "Users can insert own health documents"
  ON health_documents FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own health documents" ON health_documents;
CREATE POLICY "Users can delete own health documents"
  ON health_documents FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON health_documents TO authenticated;

-- ===== Create lab_values table =====
-- Flexible storage for ALL lab test values beyond the 13 core metrics.
-- Stores value + unit as reported by the lab (no unit conversion).
-- Immutable: no UPDATE policy. Delete + re-upload if incorrect.

CREATE TABLE IF NOT EXISTS lab_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  value NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  reference_low NUMERIC,
  reference_high NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'lab_import',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lab_values_user_date
  ON lab_values(user_id, recorded_at DESC);

ALTER TABLE lab_values ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own lab values" ON lab_values;
CREATE POLICY "Users can read own lab values"
  ON lab_values FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own lab values" ON lab_values;
CREATE POLICY "Users can insert own lab values"
  ON lab_values FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own lab values" ON lab_values;
CREATE POLICY "Users can delete own lab values"
  ON lab_values FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON lab_values TO authenticated;

-- ============================================================
-- Chat tables (March 2026)
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_updated
  ON chat_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_daily
  ON chat_messages (user_id, created_at DESC) WHERE role = 'user';

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own conversations" ON chat_conversations;
CREATE POLICY "Users can view own conversations"
  ON chat_conversations FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can create own conversations" ON chat_conversations;
CREATE POLICY "Users can create own conversations"
  ON chat_conversations FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can update own conversations" ON chat_conversations;
CREATE POLICY "Users can update own conversations"
  ON chat_conversations FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own conversations" ON chat_conversations;
CREATE POLICY "Users can delete own conversations"
  ON chat_conversations FOR DELETE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can view own messages" ON chat_messages;
CREATE POLICY "Users can view own messages"
  ON chat_messages FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can create own messages" ON chat_messages;
CREATE POLICY "Users can create own messages"
  ON chat_messages FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own messages" ON chat_messages;
CREATE POLICY "Users can delete own messages"
  ON chat_messages FOR DELETE USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations TO authenticated;
GRANT SELECT, INSERT, DELETE ON chat_messages TO authenticated;

-- Discord bot: multi-platform chat support.
-- Discord conversations all reference a single shared bot profile (DISCORD_BOT_PROFILE_ID env var);
-- individual Discord users are tracked via external_id on the conversation.
-- discord_message_id on chat_messages lets reply chains resolve to their conversation
-- in one indexed lookup (see idx_chat_messages_discord_msg_id below).
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'shopify';
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS discord_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_messages_discord_msg_id
  ON chat_messages (discord_message_id) WHERE discord_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_platform_external
  ON chat_conversations (platform, external_id) WHERE external_id IS NOT NULL;

-- Profile billing columns (Phase 2 — chat subscription)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

-- ===== Message credits (chat message packs) =====

-- Credits column on profiles (atomic deduction via CHECK constraint)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS message_credits INTEGER DEFAULT 0
  CHECK (message_credits >= 0);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS subscription_checked_at TIMESTAMPTZ;

-- Transaction audit trail (idempotent via order_id unique index)
CREATE TABLE IF NOT EXISTS message_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('purchase', 'chat_message', 'refund', 'admin_grant')),
  order_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_order
  ON message_credit_transactions(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_tx_user
  ON message_credit_transactions(user_id, created_at DESC);

ALTER TABLE message_credit_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own credit transactions" ON message_credit_transactions;
CREATE POLICY "Users read own credit transactions"
  ON message_credit_transactions FOR SELECT USING (user_id = auth.uid());

GRANT SELECT ON message_credit_transactions TO authenticated;

-- Atomic credit deduction RPC (prevents race conditions via UPDATE WHERE > 0)
CREATE OR REPLACE FUNCTION deduct_message_credit(target_user_id UUID)
RETURNS INTEGER AS $$
DECLARE new_balance INTEGER;
BEGIN
  UPDATE public.profiles SET message_credits = message_credits - 1
  WHERE id = target_user_id AND message_credits > 0
  RETURNING message_credits INTO new_balance;
  IF NOT FOUND THEN RETURN -1; END IF;
  INSERT INTO public.message_credit_transactions (user_id, amount, balance_after, reason)
  VALUES (target_user_id, -1, new_balance, 'chat_message');
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

GRANT EXECUTE ON FUNCTION deduct_message_credit(UUID) TO authenticated;

-- Atomic credit addition RPC (prevents race conditions on concurrent orders)
CREATE OR REPLACE FUNCTION add_message_credits(
  target_user_id UUID, credit_amount INT, shopify_order_id TEXT
) RETURNS INTEGER AS $$
DECLARE new_balance INTEGER;
BEGIN
  UPDATE public.profiles SET message_credits = message_credits + credit_amount
  WHERE id = target_user_id
  RETURNING message_credits INTO new_balance;
  IF NOT FOUND THEN RETURN -1; END IF;
  INSERT INTO public.message_credit_transactions (user_id, amount, balance_after, reason, order_id)
  VALUES (target_user_id, credit_amount, new_balance, 'purchase', shopify_order_id);
  RETURN new_balance;
EXCEPTION WHEN unique_violation THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

GRANT EXECUTE ON FUNCTION add_message_credits(UUID, INT, TEXT) TO authenticated;

-- ===== Create medication_history table =====
-- Immutable, append-only log of medication changes (FHIR MedicationStatement pattern).
-- UPDATE allowed only to close effective_end on previous records.

CREATE TABLE IF NOT EXISTS medication_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  medication_key TEXT NOT NULL,
  drug_name TEXT NOT NULL,
  dose_value NUMERIC,
  dose_unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped', 'intended', 'not-taken', 'on-hold')),
  effective_start TIMESTAMPTZ NOT NULL,
  effective_end TIMESTAMPTZ,
  change_type TEXT NOT NULL CHECK (change_type IN ('started', 'stopped', 'dose_changed', 'switched', 'initial')),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medication_history_user_key
  ON medication_history(user_id, medication_key, effective_start DESC);

ALTER TABLE medication_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own medication_history" ON medication_history;
CREATE POLICY "Users can read own medication_history"
  ON medication_history FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own medication_history" ON medication_history;
CREATE POLICY "Users can insert own medication_history"
  ON medication_history FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own medication_history" ON medication_history;
CREATE POLICY "Users can update own medication_history"
  ON medication_history FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own medication_history" ON medication_history;
CREATE POLICY "Users can delete own medication_history"
  ON medication_history FOR DELETE
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON medication_history TO authenticated;

-- Backfill existing medications as initial history records
INSERT INTO medication_history (user_id, medication_key, drug_name, dose_value, dose_unit, status, effective_start, change_type, source)
SELECT user_id, medication_key, drug_name, dose_value, dose_unit, status,
  COALESCE(started_at, created_at), 'initial', 'manual'
FROM medications
WHERE NOT EXISTS (
  SELECT 1 FROM medication_history mh
  WHERE mh.user_id = medications.user_id AND mh.medication_key = medications.medication_key
);

-- ===== Create supplements table =====
-- Mutable, UPSERT pattern (unique on user_id + supplement_key).

CREATE TABLE IF NOT EXISTS supplements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  supplement_key TEXT NOT NULL,
  supplement_name TEXT NOT NULL,
  dose_value NUMERIC,
  dose_unit TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, supplement_key)
);

CREATE INDEX IF NOT EXISTS idx_supplements_user ON supplements(user_id);

ALTER TABLE supplements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own supplements" ON supplements;
CREATE POLICY "Users can read own supplements"
  ON supplements FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can insert own supplements" ON supplements;
CREATE POLICY "Users can insert own supplements"
  ON supplements FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can update own supplements" ON supplements;
CREATE POLICY "Users can update own supplements"
  ON supplements FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own supplements" ON supplements;
CREATE POLICY "Users can delete own supplements"
  ON supplements FOR DELETE USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON supplements TO authenticated;

-- ===== Create supplement_history table =====
-- Immutable, append-only log of supplement changes.

CREATE TABLE IF NOT EXISTS supplement_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  supplement_key TEXT NOT NULL,
  supplement_name TEXT NOT NULL,
  dose_value NUMERIC,
  dose_unit TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
  effective_start TIMESTAMPTZ NOT NULL,
  effective_end TIMESTAMPTZ,
  change_type TEXT NOT NULL CHECK (change_type IN ('started', 'stopped', 'dose_changed')),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplement_history_user
  ON supplement_history(user_id, supplement_key, effective_start DESC);

ALTER TABLE supplement_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own supplement_history" ON supplement_history;
CREATE POLICY "Users can read own supplement_history"
  ON supplement_history FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can insert own supplement_history" ON supplement_history;
CREATE POLICY "Users can insert own supplement_history"
  ON supplement_history FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can update own supplement_history" ON supplement_history;
CREATE POLICY "Users can update own supplement_history"
  ON supplement_history FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Users can delete own supplement_history" ON supplement_history;
CREATE POLICY "Users can delete own supplement_history"
  ON supplement_history FOR DELETE USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON supplement_history TO authenticated;

-- ===== Enforce immutability on history tables =====
-- Only effective_end may be updated (to close a period). All other columns are immutable.

CREATE OR REPLACE FUNCTION enforce_history_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_id != OLD.user_id
    OR NEW.medication_key IS DISTINCT FROM OLD.medication_key
    OR NEW.drug_name IS DISTINCT FROM OLD.drug_name
    OR NEW.dose_value IS DISTINCT FROM OLD.dose_value
    OR NEW.dose_unit IS DISTINCT FROM OLD.dose_unit
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.effective_start IS DISTINCT FROM OLD.effective_start
    OR NEW.change_type IS DISTINCT FROM OLD.change_type
    OR NEW.source IS DISTINCT FROM OLD.source
  THEN
    RAISE EXCEPTION 'Only effective_end may be updated on history records';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

CREATE OR REPLACE FUNCTION enforce_supplement_history_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_id != OLD.user_id
    OR NEW.supplement_key IS DISTINCT FROM OLD.supplement_key
    OR NEW.supplement_name IS DISTINCT FROM OLD.supplement_name
    OR NEW.dose_value IS DISTINCT FROM OLD.dose_value
    OR NEW.dose_unit IS DISTINCT FROM OLD.dose_unit
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.effective_start IS DISTINCT FROM OLD.effective_start
    OR NEW.change_type IS DISTINCT FROM OLD.change_type
    OR NEW.source IS DISTINCT FROM OLD.source
  THEN
    RAISE EXCEPTION 'Only effective_end may be updated on history records';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS trg_medication_history_immutable ON medication_history;
CREATE TRIGGER trg_medication_history_immutable
  BEFORE UPDATE ON medication_history
  FOR EACH ROW EXECUTE FUNCTION enforce_history_immutability();

DROP TRIGGER IF EXISTS trg_supplement_history_immutable ON supplement_history;
CREATE TRIGGER trg_supplement_history_immutable
  BEFORE UPDATE ON supplement_history
  FOR EACH ROW EXECUTE FUNCTION enforce_supplement_history_immutability();

-- ===== Guest chat sessions =====
-- Ghost profiles support anonymous chat. A minimal profiles row (is_guest=true,
-- everything else null) satisfies the user_id FK on chat_conversations/chat_messages.
-- createUserClient(sessionId) creates a scoped JWT — same RLS as authenticated users.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS guest_chat_sessions (
  id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  session_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  ip_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_token ON guest_chat_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_ip ON guest_chat_sessions(ip_address);

ALTER TABLE guest_chat_sessions ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated = deny all client access.
-- Session management is server-side only via supabaseAdmin.
-- Chat messages are in chat_conversations/chat_messages (already RLS-protected).

-- ===== A/B Testing tables =====
-- Accessed via service key only (admin dashboard reads, storefront endpoint writes).
-- Storefront writes are HMAC-verified via Shopify app proxy.

CREATE TABLE IF NOT EXISTS ab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  target TEXT NOT NULL DEFAULT 'heading',
  variants JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Migration: add target column if table already exists
ALTER TABLE ab_tests ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'heading';

CREATE TABLE IF NOT EXISTS ab_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES ab_tests(id),
  variant_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'conversion')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (test_id, visitor_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_ab_events_test_variant ON ab_events(test_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_ab_events_test_type ON ab_events(test_id, event_type);

ALTER TABLE ab_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ab_events ENABLE ROW LEVEL SECURITY;

-- Aggregate event counts server-side. Client-side aggregation over .select()
-- silently truncates at PostgREST's default 1000-row limit once a test
-- accumulates enough events, producing wrong dashboard numbers.
CREATE OR REPLACE FUNCTION get_ab_test_counts(p_test_id UUID)
RETURNS TABLE(variant_id TEXT, event_type TEXT, count BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT variant_id, event_type, COUNT(*)::BIGINT
  FROM ab_events
  WHERE test_id = p_test_id
  GROUP BY variant_id, event_type;
$$;

GRANT EXECUTE ON FUNCTION get_ab_test_counts(UUID) TO service_role;

-- ===== chat_match_events (v2 LLM router logging) =====
-- Apply to staging BEFORE deploying Phase A code.
-- Apply to production BEFORE deploying Phase A code to production.
-- Rollback: dropping this table is safe — additive only, no existing tables modified.

CREATE TABLE IF NOT EXISTS chat_match_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message         text NOT NULL,
  router_context  jsonb,
  matched_handles text[] NOT NULL DEFAULT '{}',
  router_version  integer NOT NULL,
  router_latency_ms        integer,
  router_cache_hit         boolean,
  router_input_tokens      integer,
  router_cache_read_tokens integer,
  router_raw      text,
  router_error    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- (user_id, created_at) for weekly review queries filtered by user
CREATE INDEX IF NOT EXISTS idx_match_events_user_created  ON chat_match_events (user_id, created_at DESC);
-- GIN on matched_handles for "which queries got handle X" lookups
CREATE INDEX IF NOT EXISTS idx_match_events_handles       ON chat_match_events USING GIN (matched_handles);
-- Partial index on failures only — fast error-rate dashboards
CREATE INDEX IF NOT EXISTS idx_match_events_error_created ON chat_match_events (created_at DESC) WHERE router_error IS NOT NULL;

ALTER TABLE chat_match_events ENABLE ROW LEVEL SECURITY;

-- INSERT only: users log their own events via auth.client (user JWT).
-- No SELECT / UPDATE / DELETE policies — analytics reads go through supabaseAdmin.
-- Mirrors the chat_messages INSERT policy pattern above.
DROP POLICY IF EXISTS "Users can create own match events" ON chat_match_events;
CREATE POLICY "Users can create own match events"
  ON chat_match_events FOR INSERT
  WITH CHECK (user_id = auth.uid());

GRANT INSERT ON chat_match_events TO authenticated;

-- ===== chat_messages.is_fallback (2026-05-15) =====
-- When the main LLM call fails (API error/timeout) or returns empty content,
-- the chatbot substitutes a friendly fallback message instead of returning a
-- 500. Those substituted rows are flagged here so audits can distinguish them
-- from real bot replies. Set by both api.chat.ts (web) and
-- discord-bot.server.ts (Discord) via the shared reportChatFallback() helper
-- in app/lib/chat.server.ts.

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — sparse-true assumption; only the (rare) fallback rows are
-- indexed for fast audit queries. If fallback rate ever exceeds ~5% sustained,
-- Anthropic is broken and we have bigger problems.
CREATE INDEX IF NOT EXISTS idx_chat_messages_fallback
  ON chat_messages (created_at DESC)
  WHERE is_fallback = TRUE;

-- ===== chat_match_events.classification + router_skipped (2026-05-15) =====
-- Pre-router classifier columns. A dedicated Haiku classifier decides whether
-- the v2 router needs to fire for this turn. See app/lib/chat-classifier.server.ts
-- and chat-architecture.md § Pre-router classifier.
--
-- classification: 'ROUTE' | 'GREETING' | 'PRODUCT' | 'ACCOUNT' | 'ERROR' | NULL
--   NULL on rows from before the classifier shipped.
-- router_skipped: TRUE iff the classifier said SKIP AND the router was not
--   called. Default FALSE so pre-flag rows correctly report "router fired".

ALTER TABLE chat_match_events
  ADD COLUMN IF NOT EXISTS classification TEXT;

ALTER TABLE chat_match_events
  ADD COLUMN IF NOT EXISTS router_skipped BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — sparse-true assumption mirrors the fallback index.
-- Powers "show me all turns where the router was skipped" audit queries.
CREATE INDEX IF NOT EXISTS idx_match_events_router_skipped
  ON chat_match_events (created_at DESC)
  WHERE router_skipped = TRUE;

-- Index on classification for category-rate dashboards ("what % were GREETING
-- this week?"). Every row is non-null now that the classifier always runs, so
-- a WHERE-clause predicate would prune nothing — keep it as a plain index.
CREATE INDEX IF NOT EXISTS idx_match_events_classification
  ON chat_match_events (classification, created_at DESC);

-- router_version was NOT NULL in the original CREATE TABLE — fine when the
-- router always fired. With the pre-router classifier, SKIP turns don't fire
-- the router and we write router_version=NULL. Drop the constraint so those
-- inserts land. Idempotent in Postgres (no-op if already nullable).
ALTER TABLE chat_match_events
  ALTER COLUMN router_version DROP NOT NULL;

-- ===== Force PostgREST to reload schema cache =====
-- After table changes, PostgREST may hold stale OIDs. This nudges it to refresh.
-- NOTE: This is not always reliable — if saves break after schema changes,
-- restart the Supabase project (Settings > General > Restart project).
NOTIFY pgrst, 'reload schema';
