/**
 * tools/README.md tells users how many tools the stdio MCP server exposes.
 * It said "eight in all" after file_results (3dbbf8e3) made it nine, while
 * README.md and docs/guides/getting-started.md say nine. Housekeeping (no
 * user-facing behaviour): the sentence names every tool category and the
 * count the server lists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS } from '../packages/health-core/src/mcp-tools';

const README = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'README.md'), 'utf8').replace(/\s+/g, ' ');
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

describe('tools/README.md', () => {
  it('gives the number of tools mcp-server.ts lists', () => {
    const said = README.match(/: (\w+) in all\)/)?.[1];
    expect(said, 'the "N in all" sentence').toBeDefined();
    expect(WORDS.indexOf(said!)).toBe(MCP_TOOLS.length);
  });

  it('mentions file_results, which works on the local server', () => {
    expect(README).toMatch(/file_results/);
  });
});
