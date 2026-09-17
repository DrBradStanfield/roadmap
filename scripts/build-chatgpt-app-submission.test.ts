/**
 * US-32 — the ChatGPT app submission, generated rather than retyped.
 *
 * The listing doc used to carry a hand-written copy of the tool table and the
 * submission JSON. A tool renamed in mcp-tools.ts left both wrong with every
 * test green, and OpenAI reads them. Both artefacts are now built by
 * `build-chatgpt-app-submission.ts`; these fail if what is committed is not
 * what that build produces today, and if the listing doc's own table has
 * drifted from MCP_TOOLS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS } from '../packages/health-core/src/mcp-tools';
import { MCP_TOOL_NAMES } from '../packages/health-core/src/product-events';
import { TOOL_PROSE } from '../docs/chatgpt-app-submission.source';
import { buildGuide, buildJson, GUIDE_PATH, JSON_PATH } from './build-chatgpt-app-submission';

const REBUILD = 'npx tsx scripts/build-chatgpt-app-submission.ts';
const LISTING = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'chatgpt-app-listing.md');

describe('the generated artefacts match their source', () => {
  it(`docs/chatgpt-app-submission.json is what the build writes (${REBUILD})`, () => {
    expect(readFileSync(JSON_PATH, 'utf8')).toBe(buildJson());
  });

  it(`docs/guides/chatgpt-app.md is what the build writes (${REBUILD})`, () => {
    expect(readFileSync(GUIDE_PATH, 'utf8')).toBe(buildGuide());
  });

  it('carries every tool and invents none, with the annotations the code declares', () => {
    const json = JSON.parse(buildJson());
    expect(Object.keys(json.tools).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const tool of MCP_TOOLS) {
      expect(json.tools[tool.name].annotations, tool.name).toEqual({
        readOnlyHint: tool.annotations.readOnlyHint,
        openWorldHint: tool.annotations.openWorldHint,
        destructiveHint: tool.annotations.destructiveHint,
      });
      // Three justifications, every one answered: an empty field is a rejection.
      for (const text of Object.values(json.tools[tool.name].justifications) as string[]) {
        expect(text.length, tool.name).toBeGreaterThan(20);
      }
    }
    expect(Object.keys(TOOL_PROSE).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('names no credential, and the guide carries no em dash outside a fenced block', () => {
    // publish-guides.mjs refuses an em dash in prose; a guide that cannot be
    // published should fail here, not on the day Brad publishes.
    const guide = readFileSync(GUIDE_PATH, 'utf8');
    expect(guide.replace(/```[\s\S]*?```/g, '')).not.toContain('—');
    for (const text of [guide, readFileSync(JSON_PATH, 'utf8')]) {
      expect(text).not.toMatch(/REVIEWER_EMAIL|REVIEWER_PASSWORD|password/i);
    }
  });
});

describe('docs/chatgpt-app-listing.md — the form Brad fills in by hand', () => {
  const listing = readFileSync(LISTING, 'utf8');

  it('names every tool in its annotation table, and no tool that does not exist', () => {
    const table = listing.slice(listing.indexOf('## Tool annotations'), listing.indexOf('## Starter prompts'));
    const named = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map(([, name]) => name);
    expect(named.sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it('points at the generated JSON instead of holding a second copy of it', () => {
    expect(listing).toContain('docs/chatgpt-app-submission.json');
    expect(listing).toContain(REBUILD);
    expect(listing).not.toContain('"schema_version": 1');
  });
});
