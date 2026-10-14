/**
 * US-15 AC30: scripts/check-symlinks.mjs keeps the shared chatbot documents
 * real files that match the hash their last sync recorded (claude_business
 * tools/sync-shared-docs.mjs writes the state files). It reads the git INDEX,
 * so each case stages its files in a throwaway repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts/check-symlinks.mjs');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-symlinks-'));
  dirs.push(dir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
function check(dir: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  const r = spawnSync('node', [SCRIPT], { cwd: dir, env, encoding: 'utf-8' });
  return { code: r.status, err: r.stderr };
}
const state = (file: string, text: string) => JSON.stringify({ file, sha256: sha(text) });
const synced = (ws = 'style\n', ab = 'bank\n') => ({
  'docs/writing-style.md': ws,
  'docs/writing-style.sync.json': state('docs/writing-style.md', ws),
  'docs/chatbot/answer-bank.md': ab,
  'docs/chatbot/answer-bank.sync.json': state('docs/chatbot/answer-bank.md', ab),
});

describe('check-symlinks: shared chatbot documents (US-15 AC30)', () => {
  it('passes real files that match their recorded hashes', () => {
    expect(check(repo(synced())).code).toBe(0);
  });

  it('fails a hand edit of the generated answer bank, naming the fix', () => {
    const files = { ...synced(), 'docs/chatbot/answer-bank.md': 'bank\nhand edit\n' };
    const r = check(repo(files));
    expect(r.code).toBe(1);
    expect(r.err).toContain('docs/chatbot/answer-bank.md does not match the hash in docs/chatbot/answer-bank.sync.json');
    expect(r.err).toContain('Generated: never edit it here');
  });

  it('fails an unsynced writing-style edit, saying either copy may be edited before the sync', () => {
    const r = check(repo({ ...synced(), 'docs/writing-style.md': 'edited here\n' }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('Two-way synced with claude_business: edit either copy');
  });

  it('fails a missing answer bank or state file', () => {
    const files: Record<string, string> = synced();
    delete files['docs/chatbot/answer-bank.md'];
    expect(check(repo(files)).err).toContain('docs/chatbot/answer-bank.md is not in the index');
    const noState: Record<string, string> = synced();
    delete noState['docs/writing-style.sync.json'];
    expect(check(repo(noState)).err).toContain('has no readable hash in docs/writing-style.sync.json');
  });

  it('fails writing-style.md committed as a symlink', () => {
    const files: Record<string, string> = synced();
    delete files['docs/writing-style.md'];
    const dir = repo({ ...files, 'elsewhere.md': 'style\n' });
    symlinkSync(join(dir, 'elsewhere.md'), join(dir, 'docs/writing-style.md'));
    const r = check(dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('docs/writing-style.md is staged as a SYMLINK');
  });
});
