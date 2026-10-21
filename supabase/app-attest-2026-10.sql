-- US-52 (ios/architecture.md D8): App Attest keys for the iPhone app's chat
-- and lab upload. Operational data only: a public key, a counter, an
-- environment, and today's use counts. No IP, device name, health value or
-- request content. NOT run by agents: Brad runs it in the Supabase SQL editor
-- before the first deploy that serves /api/app/v1/*.

CREATE TABLE IF NOT EXISTS app_attest_keys (
  key_id text PRIMARY KEY,
  public_key text NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  environment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_attest_keys ADD COLUMN IF NOT EXISTS use_day date;
ALTER TABLE app_attest_keys ADD COLUMN IF NOT EXISTS chat_uses integer NOT NULL DEFAULT 0;
ALTER TABLE app_attest_keys ADD COLUMN IF NOT EXISTS lab_uses integer NOT NULL DEFAULT 0;

-- Service role only: RLS on, no policies.
ALTER TABLE app_attest_keys ENABLE ROW LEVEL SECURITY;

-- One row-locked step per request: advance the counter if higher, and count
-- one use of `p_kind` against the key's daily cap. Returns 'ok', 'stale'
-- (counter not higher: a replay or out of order), 'limit' (the counter still
-- advances: the assertion is spent) or 'unknown'.
CREATE OR REPLACE FUNCTION app_attest_use(p_key_id text, p_count bigint, p_kind text, p_cap integer)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r app_attest_keys%ROWTYPE;
  today date := (now() AT TIME ZONE 'utc')::date;
  chat integer;
  lab integer;
BEGIN
  IF p_kind NOT IN ('chat', 'lab') THEN
    RAISE EXCEPTION 'unknown kind';
  END IF;
  SELECT * INTO r FROM app_attest_keys WHERE key_id = p_key_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;
  IF p_count <= r.sign_count THEN
    RETURN 'stale';
  END IF;
  chat := CASE WHEN r.use_day = today THEN r.chat_uses ELSE 0 END;
  lab := CASE WHEN r.use_day = today THEN r.lab_uses ELSE 0 END;
  IF (p_kind = 'chat' AND chat + 1 > p_cap) OR (p_kind = 'lab' AND lab + 1 > p_cap) THEN
    UPDATE app_attest_keys SET sign_count = p_count, use_day = today, chat_uses = chat, lab_uses = lab
      WHERE key_id = p_key_id;
    RETURN 'limit';
  END IF;
  UPDATE app_attest_keys SET
    sign_count = p_count,
    use_day = today,
    chat_uses = chat + CASE WHEN p_kind = 'chat' THEN 1 ELSE 0 END,
    lab_uses = lab + CASE WHEN p_kind = 'lab' THEN 1 ELSE 0 END
    WHERE key_id = p_key_id;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION app_attest_use(text, bigint, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_attest_use(text, bigint, text, integer) TO service_role;
