/**
 * US-35 AC13 (2026-10-19): the text the connector publishes is frozen while
 * the MCP 1.0.2 submission is in OpenAI's review. Each hash is the value at
 * origin/main cab5615a (MCP_TOOLS and tools/list re-pinned for US-32 AC52 on this held branch): the server instructions, every tool definition (names,
 * descriptions, input and output schemas, annotations, _meta), the prompts and
 * the server info. A wording change in a RESULT moves none of them; a change
 * to what initialize, tools/list or prompts/list answers fails here until the
 * verdict, when the pins are re-taken on purpose.
 *
 * US-32 AC50 (2026-10-21): the definitions are not the wire. `tools/list` is
 * hashed too, as the shared dispatch answers it, so a change made while
 * serializing (annotations.title; AC51's field strip) moves a pin. Re-pinned on the held branch
 * claude/mcp-annotation-title, merged only after OpenAI's 1.0.2 verdict.
 *
 * US-32 AC52 (2026-10-21): four descriptions rewritten to name their sibling
 * tools (Glama's tool-quality grade). MCP_TOOLS and tools/list re-pinned on the
 * same held branch, so the verdict brings one freeze bump.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { INSTRUCTIONS } from './mcp.server';
import { MCP_PROMPTS, MCP_TOOLS } from '../../packages/health-core/src/mcp-tools';
import { dispatchRpc, SERVER_INFO } from '../../packages/health-core/src/mcp-rpc';

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('US-35 AC13 — the published connector text is frozen during the 1.0.2 review', () => {
  it.each([
    ['INSTRUCTIONS', INSTRUCTIONS, '765b597e650f5e6e19169462ee9aa5746ec78d46ac8680bc9224e64825bbf26d'],
    ['MCP_TOOLS', MCP_TOOLS, '88d3e15924613c03bafa48da0be1ee058e5568c25a73410a873a29595a4a7d59'],
    ['MCP_PROMPTS', MCP_PROMPTS, 'a159ee16a3ce5fefc23ed8f90178a852551350795731fabd30ca7a5f6267c140'],
    ['SERVER_INFO', SERVER_INFO, 'ce1110c13b5b005a4f14f0068138039eecd7fddc888032f08479060ad2da400f'],
  ] as const)('%s hashes to its pinned value (cab5615a; AC52 re-pin)', (_name, value, pinned) => {
    expect(sha256(value)).toBe(pinned);
  });
});

describe('US-32 AC50 — the tools/list answer itself is pinned', () => {
  it('hashes the tools both servers publish, as the dispatch serializes them', async () => {
    const answer = (await dispatchRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
      protocolVersion: (asked) => asked,
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
      callTool: async () => ({ errorMessage: 'not called' }),
    })) as { result: { tools: unknown } };
    expect(sha256(answer.result.tools)).toBe('111a51a8b8b6f34f525b65cf3e6de1d561f03c58ee9156427d385f16c7731bf0');
  });
});
