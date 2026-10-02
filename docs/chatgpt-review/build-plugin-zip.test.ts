/**
 * US-32 — the ChatGPT plugin's words cannot drift from the server.
 *
 * The retired generator (scripts/build-chatgpt-app-submission.ts) built the
 * public guide from MCP_TOOLS. The guide and the listing are hand-edited now,
 * so these fail when a tool is added or renamed without them, and when the
 * guide and the package disagree on the app's name. The package itself runs
 * through its own validator, which checks each test case's tools against the
 * same list.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS } from '../../packages/health-core/src/mcp-tools';
import { MCP_TOOL_NAMES } from '../../packages/health-core/src/product-events';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');
const TOOLS = [...MCP_TOOL_NAMES].sort();

describe('docs/guides/chatgpt-app.md — the public page', () => {
  const guide = read('../guides/chatgpt-app.md');
  const displayName: string = JSON.parse(read('plugin/plugin.json')).extensions['com.openai'].interface.displayName;

  it('describes every tool the server publishes, and none it does not', () => {
    const described = [...guide.matchAll(/^### `([a-z_]+)`:/gm)].map(([, name]) => name);
    expect(described.sort()).toEqual(TOOLS);
  });

  it('names the app as plugin.json does', () => {
    expect(guide).toMatch(new RegExp(`^title: "${displayName} in ChatGPT"$`, 'm'));
    expect(guide).toContain(`The ${displayName} app`);
  });
});

describe('docs/chatgpt-app-listing.md — the annotation table', () => {
  it('lists every tool with the hints the code declares', () => {
    const listing = read('../chatgpt-app-listing.md');
    const table = listing.slice(listing.indexOf('## Tool annotations'), listing.indexOf('## Tool justifications'));
    const rows = [...table.matchAll(/^\| `([a-z_]+)` \| (.+) \|$/gm)].map(([, name, cells]) => [
      name,
      cells.split('|').map((cell) => cell.replace(/\*/g, '').trim() === 'true'),
    ]);
    expect(rows.map(([name]) => name).sort()).toEqual(TOOLS);
    for (const tool of MCP_TOOLS) {
      const { readOnlyHint, destructiveHint, openWorldHint } = tool.annotations;
      expect(Object.fromEntries(rows)[tool.name], tool.name).toEqual([readOnlyHint, destructiveHint, openWorldHint]);
    }
  });
});

describe('docs/chatgpt-review/plugin — the package', () => {
  it('passes build-plugin-zip.mjs --check', () => {
    // Throws, with the validator's errors on stderr, on a non-zero exit.
    const out = execFileSync('node', [join(HERE, 'build-plugin-zip.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/^ok {7}health-by-dr-brad /m);
  });
});
