import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// US-15 AC6: static policy contract only; not a PostgreSQL RLS execution test.
describe('stored message INSERT policy', () => {
  it('replaces the existing permissive allowance with child AND parent ownership', () => {
    const sql = readFileSync('supabase/rls-policies.sql', 'utf8');
    const policies = [...sql.matchAll(/CREATE POLICY "([^"]+)"\s+ON chat_messages FOR INSERT\s+WITH CHECK\s*\(([\s\S]*?)\);/g)];
    expect(policies).toHaveLength(1);
    const [policy] = policies;
    expect(policy[1]).toBe('Users can create own messages');
    expect(sql.slice(0, policy.index)).toContain('DROP POLICY IF EXISTS "Users can create own messages" ON chat_messages;');
    expect(policy[2]).toMatch(/user_id = auth\.uid\(\)\s+AND EXISTS/);
    expect(policy[2]).toMatch(/FROM chat_conversations\s+WHERE chat_conversations\.id = chat_messages\.conversation_id\s+AND chat_conversations\.user_id = auth\.uid\(\)/);
  });
});
