/**
 * The text the connector publishes is pinned: the server instructions, every
 * tool definition (names, descriptions, input and output schemas, annotations,
 * _meta), the prompts, the server info, and `tools/list` as the shared
 * dispatch serializes it (US-32 AC50: the definitions are not the wire). A
 * wording change in a RESULT moves none of them.
 *
 * History: US-35 AC13 froze this text on 2026-10-19 while MCP 1.0.2 was in
 * OpenAI's review. That freeze ended on 2026-10-29, when OpenAI declined 1.0.2
 * on scope (commit 84ff1cbf; docs/ai-discoverability.md). The pins stay so any
 * change to the published text is made on purpose, while the Claude directory
 * review (submitted 2026-10-21) is open: a change fails here until its pins
 * are re-taken in the same commit, with the reason written below.
 *
 * Re-taken 2026-11-02 for US-12 AC20: read_record and get_plan say a value
 * with a comparator is a lab limit, not the number; file_results takes a
 * `comparator` (the four codes) and import candidates carry one; the
 * instructions' unit note says so too. Prompts and server info are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { INSTRUCTIONS } from './mcp.server';
import { MCP_PROMPTS, MCP_TOOLS } from '../../packages/health-core/src/mcp-tools';
import { dispatchRpc, SERVER_INFO } from '../../packages/health-core/src/mcp-rpc';

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('US-35 AC13 — the published connector text changes only on purpose', () => {
  it.each([
    ['INSTRUCTIONS', INSTRUCTIONS, '73f64dc05693aab921d50b60db290f33b37a02a51b8e509c9eb941c44f88ffae'],
    ['MCP_TOOLS', MCP_TOOLS, '350b4aa9552ef5d32c5be757d74f84d539927adf284844d8969d16206176a3d6'],
    ['MCP_PROMPTS', MCP_PROMPTS, 'a159ee16a3ce5fefc23ed8f90178a852551350795731fabd30ca7a5f6267c140'],
    ['SERVER_INFO', SERVER_INFO, 'ce1110c13b5b005a4f14f0068138039eecd7fddc888032f08479060ad2da400f'],
  ] as const)('%s hashes to its pinned value (re-taken 2026-11-02, US-12 AC20)', (_name, value, pinned) => {
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
    expect(sha256(answer.result.tools)).toBe('59e92fa521b219bf0247ae8f365e75509083c2648539a120c3b01b56c631793d');
  });
});
