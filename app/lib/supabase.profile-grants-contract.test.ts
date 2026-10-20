import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/rls-policies.sql', 'utf8').replace(/--[^\n]*/g, '');
// US-09 AC27. Static deployment contract only: actual permission enforcement
// must also be exercised with the extracted grants and RLS in PostgreSQL.
describe('profile grant deployment contract (static)', () => {
  it('revokes every default table-wide privilege before granting editable columns', () => {
    const revoke = sql.indexOf('REVOKE ALL ON profiles FROM anon, authenticated;');
    const grant = sql.indexOf('GRANT UPDATE (');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
    expect(sql).not.toMatch(/GRANT\s+[A-Z, ]*\b(UPDATE|INSERT|DELETE|TRUNCATE|ALL)\b[A-Z, ]*\s+ON\s+(TABLE\s+)?profiles\s+TO/i);
    expect(sql).not.toMatch(/GRANT[^;]*ON\s+(TABLE\s+)?profiles\s+TO[^;]*\banon\b/i);
  });
  it('allows demographic/name edits, never identity, credit or plan columns', () => {
    const grants = [...sql.matchAll(/GRANT\s+UPDATE\s*\(([^)]+)\)\s+ON\s+profiles\s+TO\s+authenticated/gi)];
    const columns = grants.flatMap(match => match[1].split(',').map(column => column.trim()));
    expect(columns.sort()).toEqual(['sex', 'birth_year', 'birth_month', 'unit_system', 'first_name', 'last_name', 'height'].sort());
    for (const column of ['id', 'shopify_customer_id', 'email', 'message_credits', 'subscription_plan', 'subscription_checked_at']) {
      expect(columns).not.toContain(column);
    }
  });
  it('the profile trigger takes the Shopify link from admin-written app metadata only', () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION handle_new_user\(\)[\s\S]*?\$\$ LANGUAGE/)?.[0] ?? '';
    expect(fn).toContain("NEW.raw_app_meta_data->>'shopify_customer_id'");
    expect(fn).not.toContain('raw_user_meta_data');
  });
});
