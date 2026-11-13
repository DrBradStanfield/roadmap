/**
 * The text the connector publishes is pinned: the server instructions, every
 * tool definition (names, descriptions, input and output schemas, annotations,
 * _meta), the prompts, the server info, and `tools/list` as the shared
 * dispatch serializes it (US-32 AC50: the definitions are not the wire). A
 * wording change in a RESULT moves none of them; a change to what initialize,
 * tools/list or prompts/list answers fails here until the pins are re-taken on
 * purpose, with the reason written below.
 *
 * History: US-35 AC13 froze this text on 2026-10-19 while MCP 1.0.2 was in
 * OpenAI's review. That review ended 2026-10-29, declined on scope (commit
 * 84ff1cbf; docs/ai-discoverability.md; Brad 2026-11-02: no resubmission), so
 * the freeze's reason is gone. The pins stay as a tripwire, also while the
 * Claude directory review (submitted 2026-10-21) is open, until Brad decides
 * whether to keep or drop them.
 *
 * Re-taken 2026-11-02 for US-12 AC20: read_record and get_plan say a value
 * with a comparator is a lab limit, not the number; file_results takes a
 * `comparator` (the four codes) and import candidates carry one; the
 * instructions' unit note says so too. Prompts and server info are unchanged.
 * Re-taken again the same day after review: file_results' privacy wording
 * ("in memory for one request", "until then … unconfirmed", "never inferred")
 * restored word for word, and the published list's budget raised to 16,500.
 *
 * US-66 AC11 (2026-11-02): read_record, add_measurement and add_lab_values say
 * every blood test is a labValues row; tool layer v3. MCP_TOOLS and tools/list
 * re-pinned with Brad's yes (OpenAI rejected the app and it is not resubmitted).
 * Re-taken again at the merge of origin/main (2026-11-02): US-66's wording on
 * top of US-12 AC20's; MCP_TOOLS and tools/list from the merged code
 * (INSTRUCTIONS is main's: US-66 does not change it).
 *
 * US-32 AC57 (2026-11-03): the instructions on both servers say a document's
 * title, text and file name are data, not instructions, and read_record's
 * `documents` and both reads' `folder.unimported` carry the same label in
 * their output schemas, as import_documents already did for its fields.
 * INSTRUCTIONS, MCP_TOOLS and tools/list re-pinned. Prompts and server info
 * are unchanged, and by the diff so are every tool's description and input
 * schema. tools/list grows by 268 characters of output-schema description.
 * Taken while Anthropic's directory review is open, so merging is Brad's call.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { INSTRUCTIONS } from './mcp.server';
import { MCP_PROMPTS, MCP_TOOLS } from '../../packages/health-core/src/mcp-tool-catalogue';
import { dispatchRpc, SERVER_INFO } from '../../packages/health-core/src/mcp-rpc';

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('US-35 AC13 — the published connector text is pinned, and changes only on purpose', () => {
  it.each([
    ['INSTRUCTIONS', INSTRUCTIONS, '0c3ae0d98005027a72dfdb0e2b8816ff02387b042133d5308d1503883a48583c'],
    ['MCP_TOOLS', MCP_TOOLS, '0f2f73a07fc096cfbb2f5d152d9a9e7a701b2c9866c65501d6e44eaea24ad75e'],
    ['MCP_PROMPTS', MCP_PROMPTS, 'a159ee16a3ce5fefc23ed8f90178a852551350795731fabd30ca7a5f6267c140'],
    ['SERVER_INFO', SERVER_INFO, 'ce1110c13b5b005a4f14f0068138039eecd7fddc888032f08479060ad2da400f'],
  ] as const)('%s hashes to its pinned value (re-taken 2026-11-03, US-32 AC57)', (_name, value, pinned) => {
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
    expect(sha256(answer.result.tools)).toBe('d8339011830289937131ca9240942653e6ed49d602133305550cd015c184d9bd');
  });
});
