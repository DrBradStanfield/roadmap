import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// US-15 AC6a: visibility and deletion require the child and its parent to belong
// to auth.uid(). This checks the checked-in policy text only. It does not prove
// PostgreSQL enforcement; that receipt is the ephemeral database run.
const SQL_PATH = 'supabase/rls-policies.sql';

function chatSection(sql: string): string {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS chat_conversations (');
  const end = sql.indexOf('-- Discord bot: multi-platform chat support.', start);
  if (start < 0 || end < start) throw new Error('chat policy section not found');
  return sql.slice(start, end);
}

function policies(sql: string, command: 'SELECT' | 'DELETE') {
  return [...sql.matchAll(new RegExp(
    `CREATE POLICY "([^"]+)"\\s+ON chat_messages FOR ${command}\\s+USING\\s*\\(([\\s\\S]*?)\\);`,
    'g',
  ))];
}

describe('stored message SELECT and DELETE policies', () => {
  it('replaces each named policy with child AND parent ownership', () => {
    const section = chatSection(readFileSync(SQL_PATH, 'utf8'));
    for (const command of ['SELECT', 'DELETE'] as const) {
      const found = policies(section, command);
      expect(found, command).toHaveLength(1);
      const [policy] = found;
      const name = command === 'SELECT' ? 'Users can view own messages' : 'Users can delete own messages';
      expect(policy[1]).toBe(name);
      expect(section.slice(0, policy.index)).toContain(`DROP POLICY IF EXISTS "${name}" ON chat_messages;`);
      expect(policy[2]).toMatch(/user_id = auth\.uid\(\)\s+AND EXISTS/);
      expect(policy[2]).toMatch(/FROM chat_conversations\s+WHERE chat_conversations\.id = chat_messages\.conversation_id\s+AND chat_conversations\.user_id = auth\.uid\(\)/);
    }
  });
});
