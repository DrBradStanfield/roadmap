/**
 * US-35 AC13 (2026-10-19): the text the connector publishes is frozen while
 * the MCP 1.0.2 submission is in OpenAI's review. Each hash is the value at
 * origin/main cab5615a: the server instructions, every tool definition (names,
 * descriptions, input and output schemas, annotations, _meta), the prompts and
 * the server info. A wording change in a RESULT moves none of them; a change
 * to what initialize, tools/list or prompts/list answers fails here until the
 * verdict, when the pins are re-taken on purpose.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { INSTRUCTIONS } from './mcp.server';
import { MCP_PROMPTS, MCP_TOOLS } from '../../packages/health-core/src/mcp-tools';
import { SERVER_INFO } from '../../packages/health-core/src/mcp-rpc';

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('US-35 AC13 — the published connector text is frozen during the 1.0.2 review', () => {
  it.each([
    ['INSTRUCTIONS', INSTRUCTIONS, '765b597e650f5e6e19169462ee9aa5746ec78d46ac8680bc9224e64825bbf26d'],
    ['MCP_TOOLS', MCP_TOOLS, '4d36f2f0084cc27973b47fcb43219e9ddf4e6b714fde81b4a4284a35aced7e31'],
    ['MCP_PROMPTS', MCP_PROMPTS, 'a159ee16a3ce5fefc23ed8f90178a852551350795731fabd30ca7a5f6267c140'],
    ['SERVER_INFO', SERVER_INFO, 'ce1110c13b5b005a4f14f0068138039eecd7fddc888032f08479060ad2da400f'],
  ] as const)('%s hashes to its value at cab5615a', (_name, value, pinned) => {
    expect(sha256(value)).toBe(pinned);
  });
});
