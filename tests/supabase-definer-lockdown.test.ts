/**
 * US-09 AC26: no SECURITY DEFINER function in supabase/rls-policies.sql is
 * callable by anon, authenticated or PUBLIC, and re-running the whole file
 * (its documented apply path) keeps it that way.
 *
 * A definer function runs with its owner's rights, Postgres grants EXECUTE
 * to PUBLIC on every new function, and Supabase's default privileges add
 * anon and authenticated. So each one must be revoked in the closing
 * lock-down section, and nothing after that section may re-create a
 * function (a DROP + CREATE resets the ACL).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = readFileSync(join(ROOT, 'supabase/rls-policies.sql'), 'utf-8');
const MARKER = '-- ===== Lock down SECURITY DEFINER functions';

/** Drop `--` comments so commented-out rollback SQL never counts. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

const SQL = stripComments(RAW);
const lockIdx = RAW.indexOf(MARKER);
const LOCKDOWN = stripComments(RAW.slice(lockIdx));

type Fn = { name: string; header: string };

/** Every CREATE FUNCTION, with its text outside the $$ body. */
function functions(sql: string): Fn[] {
  const out: Fn[] = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi;
  for (let m; (m = re.exec(sql)); ) {
    const open = sql.indexOf('$$', m.index);
    const close = sql.indexOf('$$', open + 2);
    const end = sql.indexOf(';', close);
    out.push({ name: m[1], header: sql.slice(m.index, open) + sql.slice(close + 2, end) });
  }
  return out;
}

const DEFINERS = functions(SQL).filter((f) => /SECURITY\s+DEFINER/i.test(f.header));
const definerNames = [...new Set(DEFINERS.map((f) => f.name))];

describe('SECURITY DEFINER lock-down (US-09 AC26)', () => {
  it('finds the lock-down section and the six definer functions', () => {
    expect(lockIdx).toBeGreaterThan(0);
    expect(definerNames.sort()).toEqual([
      'add_message_credits',
      'correct_measurement',
      'deduct_message_credit',
      'get_latest_measurement_dates',
      'handle_new_user',
      'youtube_bot_cleanup_skipped',
    ]);
  });

  it('revokes EXECUTE from PUBLIC, anon and authenticated on every definer function', () => {
    const revoked = [
      ...LOCKDOWN.matchAll(
        /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.(\w+)\s*\([^)]*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*;/gi,
      ),
    ].map((m) => m[1]);
    for (const name of definerNames) expect(revoked, name).toContain(name);
  });

  it('never grants a definer function to anon, authenticated or PUBLIC', () => {
    const grants = [...SQL.matchAll(/GRANT\s+(?:EXECUTE|ALL)[^;]*?ON\s+FUNCTION\s+(?:public\.)?(\w+)[^;]*?\bTO\b([^;]*);/gi)];
    for (const [stmt, name, roles] of grants) {
      if (definerNames.includes(name)) expect(roles, stmt).not.toMatch(/\b(anon|authenticated|public)\b/i);
    }
    expect(SQL).not.toMatch(/ALL\s+FUNCTIONS\s+IN\s+SCHEMA/i);
  });

  it('creates or drops no function after the lock-down section', () => {
    expect(LOCKDOWN).not.toMatch(/\b(CREATE|DROP)\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
  });

  it('keeps EXECUTE for service_role on the two functions the server calls', () => {
    expect(LOCKDOWN).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.add_message_credits\([^)]*\)\s+TO\s+service_role\s*;/i);
    expect(LOCKDOWN).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.youtube_bot_cleanup_skipped\(\)\s+TO\s+service_role\s*;/i);
  });

  it('pins a search_path on every definer function, youtube_bot_cleanup_skipped in its CREATE and an ALTER', () => {
    for (const f of DEFINERS) expect(f.header, f.name).toMatch(/SET\s+search_path\s*=/i);
    const yt = DEFINERS.find((f) => f.name === 'youtube_bot_cleanup_skipped')!;
    expect(yt.header).toMatch(/SET\s+search_path\s*=\s*public\s*,\s*pg_temp/i);
    expect(LOCKDOWN).toMatch(
      /ALTER\s+FUNCTION\s+public\.youtube_bot_cleanup_skipped\(\)\s+SET\s+search_path\s*=\s*public\s*,\s*pg_temp\s*;/i,
    );
  });
});
