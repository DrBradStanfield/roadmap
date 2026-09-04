/**
 * US-32 — the one JSON-RPC dispatch both MCP servers run.
 *
 * What is pinned here is the switch itself: the capabilities a client is told
 * about, the four prompts a person can pick without knowing what to type, and
 * the two ways a tool call can end. Each server's own half — its guards, its
 * storage, its wording — is pinned in its own suite.
 */
import { describe, expect, it } from 'vitest';
import { dispatchRpc, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, type RpcSurface } from './mcp-rpc';
import { MCP_PROMPTS, MCP_TOOLS } from './mcp-tools';

const surface: RpcSurface = {
  protocolVersion: (asked) => (asked === '2025-06-18' ? asked : '2025-11-25'),
  serverInfo: { name: 'health-roadmap', title: 'Health by Dr Brad', version: '1.0.0' },
  instructions: 'Read before you write.',
  callTool: async (name) =>
    name === 'boom' ? { errorMessage: 'That tool failed inside this server.' } : { answer: { text: 'done', isError: false } },
};

function send(method: string, params: object = {}) {
  return dispatchRpc({ jsonrpc: '2.0', id: 1, method, params }, surface) as
    Promise<{ result?: Record<string, never> & Record<string, unknown>; error?: { code: number } } | null>;
}

describe('US-32 — the shared dispatch', () => {
  it('advertises both tools and prompts, and negotiates the revision', async () => {
    const answer = await send('initialize', { protocolVersion: '2025-06-18' });
    expect(answer!.result!.capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
    expect(answer!.result!.protocolVersion).toBe('2025-06-18');
    expect((await send('initialize', { protocolVersion: '1999-01-01' }))!.result!.protocolVersion).toBe('2025-11-25');
  });

  it('lists the tools with the two words ChatGPT shows, and never the write cost', async () => {
    const listed = (await send('tools/list'))!.result!.tools as Array<Partial<(typeof MCP_TOOLS)[number]>>;
    expect(listed).toHaveLength(MCP_TOOLS.length);
    for (const tool of listed) {
      // `cost` is the hosted server's own budget weight; it is not a tool fact.
      expect(Object.keys(tool), tool.name).not.toContain('cost');
      expect(tool._meta!['openai/toolInvocation/invoking'].length, tool.name).toBeLessThanOrEqual(64);
      expect(tool._meta!['openai/toolInvocation/invoked'].length, tool.name).toBeLessThanOrEqual(64);
    }
  });

  it('offers the four prompts by name, and hands back the words behind one', async () => {
    const listed = (await send('prompts/list'))!.result!.prompts as Array<{ name: string; title: string; text?: string }>;
    expect(listed.map((p) => p.name)).toEqual(['summarise_my_plan', 'add_todays_results', 'whats_missing', 'import_my_lab_files']);
    // The list is a menu, not the message: the text arrives on prompts/get.
    expect(listed.every((p) => p.text === undefined)).toBe(true);

    const got = (await send('prompts/get', { name: 'whats_missing' }))!.result!;
    expect(got.messages).toEqual([{ role: 'user', content: { type: 'text', text: MCP_PROMPTS[2].text } }]);

    expect((await send('prompts/get', { name: 'nope' }))!.error!.code).toBe(INVALID_PARAMS);
  });

  it('carries a tool answer through, and a server-side failure as -32603 on the same id', async () => {
    expect((await send('tools/call', { name: 'read_record' }))!.result!.content).toEqual([{ type: 'text', text: 'done' }]);
    const failed = (await dispatchRpc({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'boom' } }, surface)) as
      { id: number; error: { code: number } };
    expect(failed.id).toBe(77);
    expect(failed.error.code).toBe(INTERNAL_ERROR);
  });

  it('answers a request it does not know, and stays silent on a notification', async () => {
    expect((await send('server/discover'))!.error!.code).toBe(METHOD_NOT_FOUND);
    expect(await dispatchRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, surface)).toBeNull();
  });
});
