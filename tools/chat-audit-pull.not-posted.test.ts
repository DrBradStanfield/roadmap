/**
 * US-15 AC52: a YouTube fallback or refusal row holds a line the bot never
 * posted. The audit labels it "not posted", so a reviewer does not read it as a
 * reply the viewer saw. Discord and the web did show their line, and keep the
 * plain badge. Synthetic rows, through the tool's --from-existing path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const row = (id: string, conv: string, platform: string, role: 'user' | 'assistant', over: Record<string, unknown> = {}) => ({
  message_id: id, created_at: '2026-11-03T10:00:00Z', platform, external_id: null, conversation_id: conv, user_id: 'bot',
  role, content: role === 'user' ? 'A synthetic question?' : 'Synthetic line.', model: role === 'assistant' ? 'm' : null,
  input_tokens: 0, output_tokens: 0, discord_message_id: null, is_fallback: false, failure_mode: null, error_detail: null, ...over,
});

let dir: string;
let md: string;
let html: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
  const messages = [
    row('y1', 'yt-fallback', 'youtube', 'user'),
    row('y2', 'yt-fallback', 'youtube', 'assistant', { is_fallback: true, failure_mode: 'api-error' }),
    row('y3', 'yt-refusal', 'youtube', 'user'),
    row('y4', 'yt-refusal', 'youtube', 'assistant', { failure_mode: 'refusal' }),
    row('d1', 'discord-fallback', 'discord', 'user'),
    row('d2', 'discord-fallback', 'discord', 'assistant', { is_fallback: true, failure_mode: 'api-error' }),
  ];
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages));
  writeFileSync(join(dir, 'routing.json'), '[]');
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/chat-audit-pull.ts', '--from-existing', dir], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'UTC' },
  });
  if (r.status !== 0) throw new Error(`chat-audit-pull exited ${r.status}: ${r.stderr}`);
  md = readFileSync(join(dir, 'conversations.md'), 'utf8');
  html = readFileSync(join(dir, 'conversations.html'), 'utf8');
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('US-15 AC52: chat-audit-pull labels a YouTube fallback or refusal as not posted', () => {
  it('in conversations.md', () => {
    expect(md).toContain('⚠️ FALLBACK · not posted');
    expect(md).toContain('⚠️ REFUSAL · not posted');
    // Discord posted its fallback line: one plain FALLBACK, no "not posted".
    expect(md.match(/⚠️ FALLBACK$/gm)?.length).toBe(1);
    expect(md.match(/not posted/g)?.length).toBe(2);
  });

  it('in conversations.html', () => {
    expect(html).toContain('>FALLBACK · not posted</span>');
    expect(html).toContain('>REFUSAL · not posted</span>');
    expect(html).toContain('>FALLBACK</span>');
  });
});
