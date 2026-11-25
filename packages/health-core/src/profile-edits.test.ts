// Lead I-7: the profile write lives in one place. Every writer (both MCP
// servers through mcp-tools.ts, the CLI's get-plan, the iPhone engine's My data
// and chat edits) imports `updateProfile` from profile-edits.ts; no second copy
// and no re-export. Behaviour is pinned in update-profile.pins.test.ts,
// ios/engine/update-profile-pins.test.ts and tools/get-plan-profile.pins.test.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOTS = ['packages/health-core/src', 'ios/engine', 'tools', 'app/lib', 'widget-src/src'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('__') ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('I-7: one profile write', () => {
  const files = ROOTS.flatMap((root) => sources(join(REPO, root))).map((path) => ({ path: relative(REPO, path), text: readFileSync(path, 'utf8') }));

  it('updateProfile is defined only in profile-edits.ts, and nothing re-exports it', () => {
    expect(files.filter((f) => /function updateProfile\(/.test(f.text)).map((f) => f.path)).toEqual(['packages/health-core/src/profile-edits.ts']);
    expect(files.filter((f) => /export\s*\{[^}]*\bupdateProfile\b[^}]*\}/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('every production caller imports it from profile-edits', () => {
    const callers = files.filter((f) => /\bupdateProfile\(/.test(f.text) && !f.path.endsWith('profile-edits.ts'));
    expect(callers.map((f) => f.path).sort()).toEqual([
      'ios/engine/chat-edits.ts',
      'ios/engine/my-data.ts',
      'packages/health-core/src/mcp-tools.ts',
      'tools/get-plan.ts',
    ]);
    for (const f of callers) expect(f.text, f.path).toMatch(/import \{ updateProfile \} from '[./]+(?:packages\/health-core\/src\/)?profile-edits';/);
  });
});
