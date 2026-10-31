/**
 * tools/chat-audit-pull.ts renders real users' chats, and the bot's replies,
 * into conversations.html for review in a browser. Every text field comes from
 * a user or a model, so a missed escape runs their markup in the reviewer's
 * browser. This renders a conversation whose every text field is hostile,
 * through the tool's own --from-existing path (no Supabase), and checks none of
 * it arrives as markup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '<img src=x onerror=alert(1)>';
const BREAKOUT = '"><svg onload=alert(1)>';
const SCRIPT = '</script><script>alert(1)</script>';
const HOSTILE = `${TAG} ${BREAKOUT} ${SCRIPT}`;

const message = (id: string, role: 'user' | 'assistant', content: string) => ({
  message_id: id,
  created_at: '2026-10-01T10:00:00Z',
  platform: 'widget',
  external_id: HOSTILE,
  conversation_id: 'conv-1',
  user_id: 'user-1',
  role,
  content,
  model: role === 'assistant' ? HOSTILE : null,
  input_tokens: 1,
  output_tokens: 1,
  discord_message_id: null,
  is_fallback: role === 'assistant',
  failure_mode: role === 'assistant' ? HOSTILE : null,
  error_detail: role === 'assistant' ? HOSTILE : null,
});

let dir: string;
let html: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
  const messages = [
    message('m1', 'user', `Hi ${HOSTILE}\n# ${HOSTILE}\n- ${HOSTILE}\n\`${HOSTILE}\`\n\`\`\`${BREAKOUT}\n${HOSTILE}\n\`\`\``),
    message('m2', 'assistant', `**${HOSTILE}** *${HOSTILE}* [see this](javascript:alert(1)) [and](JavaScript:alert(1)) [ok](https://drstanfield.com/x)`),
  ];
  const routing = [{
    created_at: '2026-10-01T10:00:00Z', message_id: 'm1', conversation_id: 'conv-1', user_id: 'user-1', message: HOSTILE,
    router_context: { platform: 'widget' }, is_fallback: false, failure_mode: null, matched_handles: [HOSTILE],
    router_latency_ms: 5, router_cache_hit: false, router_error: HOSTILE, router_raw: HOSTILE, classification: HOSTILE, router_skipped: false,
  }];
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages));
  writeFileSync(join(dir, 'routing.json'), JSON.stringify(routing));
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/chat-audit-pull.ts', '--from-existing', dir], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'UTC' },
  });
  if (r.status !== 0) throw new Error(`chat-audit-pull exited ${r.status}: ${r.stderr}`);
  html = readFileSync(join(dir, 'conversations.html'), 'utf8');
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('chat-audit-pull conversations.html', () => {
  it('renders the conversation (guards against an empty page passing)', () => {
    expect(html).toContain('see this');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('turns no user or model text into markup', () => {
    expect(html).not.toContain(TAG);
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<script>alert(1)');
    expect(html.match(/<\/script>/g)?.length).toBe(1); // the tool's own script only
  });

  it('links only to web addresses, never javascript:', () => {
    expect(html).not.toMatch(/href="\s*javascript:/i);
    expect(html).toContain('href="https://drstanfield.com/x"');
  });
});
