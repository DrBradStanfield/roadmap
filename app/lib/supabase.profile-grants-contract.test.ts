import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/rls-policies.sql', 'utf8').replace(/--[^\n]*/g, '');
// US-15 AC9. Static deployment contract only: actual permission enforcement
// must also be exercised with the extracted grants and RLS in PostgreSQL.
describe('profile UPDATE grant deployment contract (static)', () => {
  it('revokes the previous table-wide grant before granting editable columns', () => {
    const revoke = sql.indexOf('REVOKE UPDATE ON profiles FROM authenticated;');
    const grant = sql.indexOf('GRANT UPDATE (');
    expect(revoke).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(revoke);
    expect(sql).not.toMatch(/GRANT\s+SELECT,\s*UPDATE\s+ON\s+profiles\s+TO\s+authenticated/i);
  });
  it('allows demographic/name edits, never identity columns', () => {
    const grants = [...sql.matchAll(/GRANT\s+UPDATE\s*\(([^)]+)\)\s+ON\s+profiles\s+TO\s+authenticated/gi)];
    const columns = grants.flatMap(match => match[1].split(',').map(column => column.trim()));
    expect(columns.sort()).toEqual(['sex', 'birth_year', 'birth_month', 'unit_system', 'first_name', 'last_name', 'height'].sort());
    for (const column of ['id', 'shopify_customer_id', 'email']) expect(columns).not.toContain(column);
  });
});
