import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/rls-policies.sql', 'utf8').replace(/--[^\n]*/g, '');
// US-09 AC27. Static deployment contract only: actual permission enforcement
// must also be exercised with the extracted grants and RLS in PostgreSQL.
describe('profile grant deployment contract (static)', () => {
  it('revokes every default privilege, then grants authenticated SELECT only (getProfile)', () => {
    const revoke = sql.indexOf('REVOKE ALL ON profiles FROM anon, authenticated;');
    const select = sql.indexOf('GRANT SELECT ON profiles TO authenticated;');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(revoke);
    const grants = [...sql.matchAll(/GRANT\s+([^;]*?)\s+ON\s+(?:TABLE\s+)?profiles\s+TO\s+([^;]+);/gi)];
    expect(grants.map(m => `${m[1].trim()} TO ${m[2].trim()}`)).toEqual(['SELECT TO authenticated']);
  });
  it('no policy lets a session holder write a profile row', () => {
    expect(sql).not.toMatch(/CREATE\s+POLICY[^;]*ON\s+profiles\s+FOR\s+(UPDATE|INSERT|DELETE|ALL)/i);
    expect(sql).toContain('DROP POLICY IF EXISTS "Users can update own profile" ON profiles;');
  });
  it('the profile trigger takes the Shopify link from admin-written app metadata only', () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION handle_new_user\(\)[\s\S]*?\$\$ LANGUAGE/)?.[0] ?? '';
    expect(fn).toContain("NEW.raw_app_meta_data->>'shopify_customer_id'");
    expect(fn).not.toContain('raw_user_meta_data');
  });
});
