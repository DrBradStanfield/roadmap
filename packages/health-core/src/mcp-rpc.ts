/**
 * One JSON-RPC dispatch, shared by both MCP servers (US-32).
 *
 * The hosted server (`app/lib/mcp.server.ts`) and the stdio server
 * (`tools/mcp-server.ts`) answer the same five methods in the same words. They
 * used to hold a copy each, and the copies had already drifted cosmetically —
 * which is how that kind of duplication announces itself. What actually
 * differs is small enough to hand in: how a protocol version is negotiated,
 * what the server calls itself, and what a tool call costs, guards and all.
 *
 * Nothing here reads the clock, the filesystem or the network.
 */
import { MCP_PROMPTS, MCP_TOOLS, SERVER_VERSION, toolContent, type ToolAnswer } from './mcp-tools';

/** The revision both servers speak. The hosted one also accepts older ones. */
export const PROTOCOL_VERSION = '2025-11-25';

/** What both servers call themselves. One name, one version, one place. */
export const SERVER_INFO = { name: 'health-roadmap', title: 'Health by Dr Brad', version: SERVER_VERSION };

export type RpcId = string | number | null;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function rpcResult(id: RpcId, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}

export function rpcFailure(id: RpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * A tool call's outcome as this layer needs it: an answer to wrap, or a
 * JSON-RPC error to report on this request's id. Each server catches its own
 * failures — a storage failure is words the user can act on, a bug in us is
 * `-32603` — and hands back whichever it decided on.
 */
export type RpcToolOutcome = { answer: ToolAnswer } | { errorMessage: string };

export interface RpcSurface {
  /** The revision to answer with, given what the client asked for. */
  protocolVersion(asked: string): string;
  serverInfo: { name: string; title: string; version: string };
  instructions: string;
  callTool(name: string, args: unknown): Promise<RpcToolOutcome>;
}

/**
 * Answer one message, or `null` for a notification. Nothing is remembered
 * between messages: a client that skips `initialize` is served anyway, which
 * is what the next protocol revision expects.
 */
export async function dispatchRpc(incoming: unknown, surface: RpcSurface): Promise<object | null> {
  // Valid JSON that is not an object is not a request, and must not fall
  // through as a notification: a client that sent a batch — removed from MCP
  // after 2025-03 — would wait forever on the silence.
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return rpcFailure(null, INVALID_REQUEST, 'A request must be a JSON object');
  }
  const message = incoming as { id?: RpcId; method?: unknown; params?: unknown };
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (!method) return isNotification ? null : rpcFailure(id, INVALID_REQUEST, 'A request needs a method');

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: surface.protocolVersion(asked),
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: surface.serverInfo,
        instructions: surface.instructions,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // `cost` is the hosted server's own write-budget weight, not part of a
      // tool definition — it never goes on the wire.
      return rpcResult(id, { tools: MCP_TOOLS.map(({ cost, ...tool }) => tool) });
    case 'prompts/list':
      return rpcResult(id, { prompts: MCP_PROMPTS.map(({ name, title }) => ({ name, title })) });
    case 'prompts/get': {
      const prompt = MCP_PROMPTS.find((candidate) => candidate.name === params.name);
      if (!prompt) return rpcFailure(id, INVALID_PARAMS, `No prompt named ${String(params.name ?? '')}`);
      return rpcResult(id, { messages: [{ role: 'user', content: { type: 'text', text: prompt.text } }] });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return rpcFailure(id, INVALID_PARAMS, 'tools/call needs a tool name');
      const outcome = await surface.callTool(name, params.arguments);
      return 'answer' in outcome
        ? rpcResult(id, toolContent(outcome.answer))
        : rpcFailure(id, INTERNAL_ERROR, outcome.errorMessage);
    }
    default:
      return isNotification ? null : rpcFailure(id, METHOD_NOT_FOUND, `Unknown method ${method}`);
  }
}
