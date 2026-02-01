-- Supabase RLS Policies for Health Roadmap Tool
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
--
-- These policies provide defense-in-depth. The app currently uses the service
-- role key (which bypasses RLS), but these policies:
--   1. Document the intended access patterns
--   2. Protect against future code bugs if switching to anon key
--   3. Are a prerequisite for HIPAA compliance

-- ===== Drop old table =====

DROP TABLE IF EXISTS health_profiles;

-- ===== Create health_measurements table =====

CREATE TABLE IF NOT EXISTS health_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'height', 'weight', 'waist',
    'hba1c', 'ldl', 'hdl', 'triglycerides', 'fasting_glucose',
    'systolic_bp', 'diastolic_bp',
    'sex', 'birth_year', 'birth_month'
  )),
  value NUMERIC NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_measurements_user_type_date
  ON health_measurements(user_id, metric_type, recorded_at DESC);

-- ===== Optional RPC for efficient "latest per metric" query =====

CREATE OR REPLACE FUNCTION get_latest_measurements(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  metric_type TEXT,
  value NUMERIC,
  recorded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (m.metric_type)
    m.id,
    m.user_id,
    m.metric_type,
    m.value,
    m.recorded_at,
    m.created_at
  FROM health_measurements m
  WHERE m.user_id = p_user_id
  ORDER BY m.metric_type, m.recorded_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ===== Drop previous policies =====
-- (Must come AFTER table creation so the table exists for DROP POLICY)

DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
-- Note: health_profiles policies were dropped with the table above
DROP POLICY IF EXISTS "Users can read own measurements" ON health_measurements;
DROP POLICY IF EXISTS "Users can insert own measurements" ON health_measurements;
DROP POLICY IF EXISTS "Users can delete own measurements" ON health_measurements;

-- ===== Enable RLS =====

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_measurements ENABLE ROW LEVEL SECURITY;

-- ===== Profiles policies =====

CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (id::text = auth.uid()::text);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (id::text = auth.uid()::text);

-- ===== Health measurements policies =====
-- No UPDATE policy — records are immutable (Apple Health model: delete + re-add).

CREATE POLICY "Users can read own measurements"
  ON health_measurements FOR SELECT
  USING (user_id::text IN (SELECT id::text FROM profiles WHERE id::text = auth.uid()::text));

CREATE POLICY "Users can insert own measurements"
  ON health_measurements FOR INSERT
  WITH CHECK (user_id::text IN (SELECT id::text FROM profiles WHERE id::text = auth.uid()::text));

CREATE POLICY "Users can delete own measurements"
  ON health_measurements FOR DELETE
  USING (user_id::text IN (SELECT id::text FROM profiles WHERE id::text = auth.uid()::text));

-- Note: The service role key bypasses all RLS policies, so the existing
-- application code continues to work unchanged. These policies only take
-- effect for requests using the anon key or authenticated user tokens.
--
-- When you're ready to switch from service key to anon key (recommended
-- for HIPAA), you'll need to:
--   1. Set up Supabase Auth for your users
--   2. Map Shopify customer IDs to Supabase auth.uid()
--   3. Switch the client to use the anon key
--   4. Test thoroughly — RLS will then enforce these policies
