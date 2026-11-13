// US-32 AC51a: the golden pin of what a connected AI client reads from tools/list.
// Both servers list the same thing: the stdio server passes no `tools`, and the hosted
// one passes none while its knowledge switch is off (US-41 AC6), so dispatchRpc lists
// MCP_TOOLS for both. The comparison is on bytes, key order included.
//
// Regenerate only when a change to the published tools is intended and approved:
//   cd packages/health-core && UPDATE_TOOLS_LIST_GOLDEN=1 npx vitest run src/mcp-tools-list.golden.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dispatchRpc, type RpcSurface } from './mcp-rpc';

const PATH = `${__dirname}/mcp-tools-list.golden.json`;

const surface: RpcSurface = {
  protocolVersion: (asked) => asked,
  serverInfo: { name: 'health-roadmap', title: 'Health by Dr Brad', version: 'test' },
  instructions: '',
  callTool: async () => ({ errorMessage: 'not called' }),
};

describe('US-32 AC51a: tools/list is pinned byte for byte', () => {
  it('lists every tool (name, title, description, inputSchema, outputSchema, annotations, _meta) exactly as the golden', async () => {
    const answer = (await dispatchRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, surface)) as { result: { tools: unknown[] } };
    const actual = `${JSON.stringify(answer.result.tools, null, 1)}\n`;
    if (process.env.UPDATE_TOOLS_LIST_GOLDEN) writeFileSync(PATH, actual);
    expect(actual).toBe(readFileSync(PATH, 'utf8'));
  });
});
