/**
 * Golden pins for tools/chat-audit-pull.ts before it is split (a pure move). The tool is a CLI with no
 * exports, so these pin what it writes: conversations.md, conversations.html and its console lines,
 * rendered through --from-existing (no Supabase) from SYNTHETIC rows only, plus its (empty) export list.
 * Today's date and the temp folder are normalised. The pull path is pinned by chat-audit-pull.row-cap.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const msg = (id: string, conv: string, platform: string, role: 'user' | 'assistant', at: string, content: string, over: Record<string, unknown> = {}) => ({
  message_id: id, created_at: at, platform, external_id: null, conversation_id: conv, user_id: `u-${conv}`, role, content,
  model: role === 'assistant' ? 'model-x' : null, input_tokens: role === 'assistant' ? 10 : null, output_tokens: role === 'assistant' ? 20 : null,
  discord_message_id: null, is_fallback: false, failure_mode: null, error_detail: null, ...over,
});
const route = (at: string, message_id: string | null, conv: string | null, platform: string, over: Record<string, unknown> = {}) => ({
  created_at: at, message_id, conversation_id: conv, user_id: `u-${conv}`, message: 'Synthetic question?', router_context: { platform },
  is_fallback: false, failure_mode: null, matched_handles: ['handle-a', 'handle-b'], router_latency_ms: 12, router_cache_hit: false,
  router_error: null, router_raw: null, classification: null, router_skipped: null, ...over,
});

const MARKDOWN = [
  '# Heading one', '## Heading two', 'A **bold** and *italic* line with `code` and [a link](https://example.com/a).',
  '', '', '- bullet one', '* bullet two', '1. first', '2. second', '', '```js', 'const x = 1 < 2;', '```',
  '[bad](javascript:void(0)) [mail](mailto:a@example.com)', 'plain line',
].join('\n');

const messages = [
  msg('s1', 'c-shop', 'shopify', 'user', '2026-10-02T09:00:00Z', 'Synthetic shop question?'),
  msg('s2', 'c-shop', 'shopify', 'assistant', '2026-10-02T09:00:05Z', MARKDOWN),
  msg('s3', 'c-shop', 'shopify', 'user', '2026-10-02T09:01:00Z', '[removed after 30 days]'),
  msg('s4', 'c-shop', 'shopify', 'assistant', '2026-10-02T09:01:05Z', 'Long reply. '.repeat(200), { model: null }),
  msg('d1', 'c-disc', 'discord', 'user', '2026-10-02T08:00:00Z', 'Synthetic discord question?', { external_id: 'ext-1' }),
  msg('d2', 'c-disc', 'discord', 'assistant', '2026-10-02T08:00:03Z', 'Synthetic fallback line.', { is_fallback: true, failure_mode: 'api-error', error_detail: 'synthetic 503' }),
  msg('y1', 'c-yt', 'youtube', 'user', '2026-10-02T07:00:00Z', 'Synthetic youtube question?', { external_id: 'comment-1' }),
  msg('y2', 'c-yt', 'youtube', 'assistant', '2026-10-02T07:00:02Z', 'Synthetic refusal line.', { failure_mode: 'refusal' }),
];
const routing = [
  route('2026-10-02T09:00:00Z', 's1', 'c-shop', 'shopify', { classification: 'ROUTE', router_cache_hit: true }),
  route('2026-10-02T09:01:00Z', 's3', 'c-shop', 'shopify', { matched_handles: [], router_error: 'synthetic router error', classification: 'SKIP', router_skipped: true, router_latency_ms: null }),
  route('2026-10-02T08:00:00Z', 'd1', 'c-disc', 'discord'),
  route('2026-10-02T06:00:00Z', null, 'c-widget', 'widget', { message: 'Synthetic widget question?' }),
  route('2026-10-02T06:05:00Z', null, 'c-widget', 'widget', { message: null }),
  route('2026-10-02T05:00:00Z', null, 'c-yt-old', 'youtube', { is_fallback: true, failure_mode: 'api-error' }),
];

let dir: string;
const out: Record<string, string> = {};

function run(extra: string[]): { stdout: string; status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/chat-audit-pull.ts', '--from-existing', dir, ...extra], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'UTC' },
  });
  return { stdout: r.stdout, status: r.status, stderr: r.stderr };
}
const norm = (s: string) => s.split(dir).join('<DIR>').replace(/(ending|Chat Audit —) \d{4}-\d{2}-\d{2}/g, '$1 <TODAY>');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-audit-pin-'));
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages));
  writeFileSync(join(dir, 'routing.json'), JSON.stringify(routing));
  const noHtml = run(['--no-html', '--days', '1']);
  if (noHtml.status !== 0) throw new Error(`chat-audit-pull exited ${noHtml.status}: ${noHtml.stderr}`);
  out.stdoutNoHtml = norm(noHtml.stdout);
  out.mdOneDay = norm(readFileSync(join(dir, 'conversations.md'), 'utf8'));
  const full = run([]);
  if (full.status !== 0) throw new Error(`chat-audit-pull exited ${full.status}: ${full.stderr}`);
  out.stdout = norm(full.stdout);
  out.md = norm(readFileSync(join(dir, 'conversations.md'), 'utf8'));
  out.html = norm(readFileSync(join(dir, 'conversations.html'), 'utf8'));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('chat-audit-pull golden pins (pre-split)', () => {
  it('exports nothing (a CLI)', () => {
    const file = join(ROOT, 'tools/chat-audit-pull.ts');
    const program = ts.createProgram([file], { allowJs: true, noEmit: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
    const sym = program.getTypeChecker().getSymbolAtLocation(program.getSourceFile(file)!);
    const names = sym ? program.getTypeChecker().getExportsOfModule(sym).map(s => s.name).sort() : [];
    expect(names).toMatchSnapshot();
  });

  it('console lines', () => {
    expect(out.stdout).toMatchSnapshot();
    expect(out.stdoutNoHtml).toMatchSnapshot();
  });

  it('conversations.md', () => {
    expect(out.md).toContain('Synthetic widget question?');
    expect(out.md).toMatchSnapshot();
    expect(out.mdOneDay).toContain('1 days ending');
  });

  it('conversations.html', () => {
    expect(out.html).toContain('<h3 class="msg-h">Heading one</h3>');
    expect(out.html).toMatchSnapshot();
  });
});
