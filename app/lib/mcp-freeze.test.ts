/**
 * US-35 AC13 (2026-10-19): the text the connector publishes was frozen while
 * the MCP 1.0.2 submission was in OpenAI's review. That review ended
 * 2026-10-29 (declined on scope; Brad 2026-11-02: no resubmission), so the
 * reason for the freeze is gone. The pins stay, as a tripwire, until Brad
 * decides whether to keep or drop them (PR for 2026-11-02). Each hash is the
 * value after PR #209 (US-32 AC50, AC52): the server instructions, every tool
 * definition (names, descriptions, input and output schemas, annotations,
 * _meta), the prompts and the server info. A wording change in a RESULT moves
 * none of them; a change to what initialize, tools/list or prompts/list
 * answers fails here until the pins are re-taken on purpose.
 *
 * US-32 AC50 (2026-10-21): the definitions are not the wire. `tools/list` is
 * hashed too, as the shared dispatch answers it, so a change made while
 * serializing (annotations.title; AC51's field strip) moves a pin.
 *
 * US-66 AC11 (2026-11-02): read_record, add_measurement and add_lab_values say
 * every blood test is a labValues row; tool layer v3. MCP_TOOLS and tools/list
 * re-pinned with Brad's yes (OpenAI rejected the app and it is not resubmitted).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { INSTRUCTIONS } from './mcp.server';
import { MCP_PROMPTS, MCP_TOOLS } from '../../packages/health-core/src/mcp-tools';
import { dispatchRpc, SERVER_INFO } from '../../packages/health-core/src/mcp-rpc';

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('US-35 AC13 — the published connector text is pinned (frozen for the 1.0.2 review, which ended 2026-10-29)', () => {
  it.each([
    ['INSTRUCTIONS', INSTRUCTIONS, '765b597e650f5e6e19169462ee9aa5746ec78d46ac8680bc9224e64825bbf26d'],
    ['MCP_TOOLS', MCP_TOOLS, 'f9e34af359f0590560d558e9ad77c8e6b4e0b394d515d519f1b2bee757ab8184'],
    ['MCP_PROMPTS', MCP_PROMPTS, 'a159ee16a3ce5fefc23ed8f90178a852551350795731fabd30ca7a5f6267c140'],
    ['SERVER_INFO', SERVER_INFO, 'ce1110c13b5b005a4f14f0068138039eecd7fddc888032f08479060ad2da400f'],
  ] as const)('%s hashes to its pinned value (cab5615a; AC52 re-pin; US-66 re-pin)', (_name, value, pinned) => {
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
    expect(sha256(answer.result.tools)).toBe('f2b0aeb93e6238b177a63ad03e76a724d1d74db8cfbacf5fb635956394f82393');
  });
});
