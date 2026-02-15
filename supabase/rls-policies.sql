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
    'systolic_bp', 'diastolic_bp', 'apob', 'creatinine', 'psa'
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
    'systolic_bp', 'diastolic_bp', 'apob', 'creatinine', 'psa'
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===== Unique constraint on shopify_customer_id =====

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
  FROM health_measurements m
  WHERE m.user_id = auth.uid()
  ORDER BY m.metric_type, m.recorded_at DESC;
END;
$$ LANGUAGE plpgsql;

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
    'statin', 'ezetimibe', 'statin_escalation', 'statin_increase', 'pcsk9i',
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
    'endometrial_discussion', 'endometrial_abnormal_bleeding'
  )),
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, screening_key)
);

CREATE INDEX IF NOT EXISTS idx_screenings_user ON screenings(user_id);

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
    'screening_lung', 'screening_prostate',
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

-- ===== Force PostgREST to reload schema cache =====
-- After table changes, PostgREST may hold stale OIDs. This nudges it to refresh.
-- NOTE: This is not always reliable — if saves break after schema changes,
-- restart the Supabase project (Settings > General > Restart project).
NOTIFY pgrst, 'reload schema';
