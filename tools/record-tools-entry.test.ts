/**
 * US-32 AC56: the record tools run when they are started through a symlink.
 *
 * Each tool runs its CLI only when it is the script Node was asked to run. Node
 * resolves the entry module to its real path, so `import.meta.url` names the
 * real file while `process.argv[1]` keeps the path as typed. Compared as they
 * were, a path through a symlinked folder (a repo inside ~/Dropbox on a Mac, or
 * under /tmp) never matched: the tool printed nothing and exited 0, and the MCP
 * server exited without answering, so Claude Desktop got no server.
 * scripts/build-user-stories-html.ts already resolves both sides.
 *
 * The tools run as child processes through a symlink to this checkout, with the
 * same call through the real path as a control. Synthetic record only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyFile } from '../packages/health-core/src/roadmap-file';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let dir: string;
let linked: string;
let record: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'record-tools-entry-'));
  linked = join(dir, 'repo');
  symlinkSync(ROOT, linked, 'dir');
  record = join(dir, 'health-roadmap.json');
  const file = createEmptyFile({ deviceId: 'entry-test', now: '2026-10-01T00:00:00.000Z' });
  writeFileSync(record, JSON.stringify({ ...file, profile: { ...file.profile, heightCm: 178 } }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run one tool by an absolute path under `root`, from a folder outside the repo. */
function run(root: string, tool: string, args: string[], input = '') {
  return spawnSync(process.execPath, [TSX, join(root, 'tools', tool), ...args], {
    cwd: dir, encoding: 'utf8', input, timeout: 60_000, env: { PATH: process.env.PATH ?? '', TZ: 'UTC' },
  });
}

const INITIALIZE = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'entry-test', version: '0' } } })}\n`;

describe('US-32 AC56: a record tool started through a symlink runs', () => {
  for (const [label, root] of [['through a symlink', () => linked], ['by its real path (control)', () => ROOT]] as const) {
    describe(label, () => {
      it('get-plan prints its help', () => {
        const r = run(root(), 'get-plan.ts', ['--help']);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('get_plan — compute your health plan');
      }, 60_000);

      it('get-plan reads the record', () => {
        const r = run(root(), 'get-plan.ts', [record]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('YOUR HEALTH PLAN');
      }, 60_000);

      it('edit-record prints its help', () => {
        const r = run(root(), 'edit-record.ts', ['--help']);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('edit_record — add and correct values');
      }, 60_000);

      it('the MCP server answers initialize', () => {
        const r = run(root(), 'mcp-server.ts', ['--file', record], INITIALIZE);
        expect(r.status).toBe(0);
        const reply = JSON.parse(r.stdout.trim().split('\n')[0] ?? 'null');
        expect(reply).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: expect.any(Object) } });
      }, 60_000);
    });
  }
});
