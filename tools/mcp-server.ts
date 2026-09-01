#!/usr/bin/env tsx
/**
 * The health record as an MCP server, over stdio (US-32, phase 0).
 *
 * Point Claude Desktop or Claude Code at one `health-roadmap.json` and the
 * assistant can read the record, compute the plan, add results, correct a value
 * and prepare a bug report — through the same functions the CLI uses, so
 * nothing here can invent its own idea of a legal write. Local only: one file
 * path, no server, no OAuth, no key, no network. The hosted server (phase 1)
 * wraps this same tool layer around a user's cloud folder.
 *
 * Usage:
 *   npx tsx tools/mcp-server.ts --file ~/Dropbox/Apps/health-roadmap/health-roadmap.json
 *
 * stdout is the transport — it carries JSON-RPC and nothing else. Anything a
 * human should read goes to stderr.
 */
import { pathToFileURL } from 'node:url';
import { callTool, isToolName, MCP_TOOLS, SERVER_VERSION } from '../packages/health-core/src/mcp-tools';
import { PlanError } from '../packages/health-core/src/plan';
import { assertUnchanged, backup, openRecord, writeAtomic } from './record-io';

/** The revision this speaks. Clients that ask for another get told this one. */
const PROTOCOL_VERSION = '2025-11-25';

const SERVER_INFO = { name: 'health-roadmap', title: 'Health Roadmap', version: SERVER_VERSION };

/** What the assistant is told once, at connect. */
const INSTRUCTIONS =
  'These tools read and write ONE local health record file — the user’s own. Read before you write: values are ' +
  'slotted one per metric per day, and a day that already holds a value is corrected, never added to twice. ' +
  'Nothing is ever deleted; a superseded row stays as "entered-in-error". The plan from get_plan is educational, ' +
  'not medical advice, and its hedged wording and citations are calibrated — pass them on as written. ' +
  'If a tool refuses something the user reasonably expected, the record cannot hold what they want to track, or a ' +
  'result looks wrong, offer report_feedback: it prepares a GitHub issue link, carrying no health values, that the ' +
  'user reviews and submits themselves.';

export const HELP = `mcp-server — your health record as an MCP server, over stdio.

  npx tsx tools/mcp-server.ts --file <path to health-roadmap.json>

Tools: ${MCP_TOOLS.map((t) => t.name).join(', ')}.

In Claude Desktop, add this to claude_desktop_config.json:

  {
    "mcpServers": {
      "health-roadmap": {
        "command": "npx",
        "args": ["tsx", "<repo>/tools/mcp-server.ts", "--file", "<path to health-roadmap.json>"]
      }
    }
  }

The file is read fresh on every call, backed up before every write, and
replaced atomically. No network, no model, no telemetry.
`;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

type Id = string | number | null;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function result(id: Id, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id: Id, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A tool's answer, as MCP carries it: text content, plus a flag if it refused. */
function toolResult(id: Id, text: string, isError = false) {
  return result(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : null) });
}

// ---------------------------------------------------------------------------
// Tool calls against the file
// ---------------------------------------------------------------------------

/**
 * One tool call, from bytes to bytes: read the record fresh (another device or
 * the app itself may have written it since the last call), run the tool, and
 * only if the tool produced a new file — back it up, check nothing moved
 * underneath, and replace it atomically. `record-io.ts` owns that boundary, so
 * the CLI and this server cannot lose the file in different ways.
 */
function callAgainstFile(path: string, name: string, args: unknown): { text: string; isError: boolean } {
  if (!isToolName(name)) return { text: `No tool named ${name}.`, isError: true };
  const now = new Date().toISOString();
  const record = openRecord(path);
  const outcome = callTool(name, args, { file: record.file, now });
  if (outcome.status !== 'ok') return { text: outcome.text, isError: true };
  if (!outcome.file) return { text: outcome.text, isError: false };

  assertUnchanged(record.path, record.stamp);
  const bak = backup(record.path, now);
  writeAtomic(record.path, outcome.file);
  return { text: `${outcome.text}\nSaved (backup: ${bak}).`, isError: false };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Answer one message, or `null` for a notification. Nothing here is stateful:
 * a client that skips `initialize` still gets served, which is what the next
 * protocol revision expects anyway.
 */
export function handle(incoming: unknown, path: string): object | null {
  // Valid JSON that is not an object is not a request, and must not fall
  // through as a notification: a client that sent a batch — removed from MCP
  // after 2025-03 — would wait forever on the silence.
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return failure(null, INVALID_REQUEST, 'A request must be a JSON object');
  }
  const message = incoming as RpcMessage;
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;

  if (!method) return isNotification ? null : failure(id, INVALID_REQUEST, 'A request needs a method');

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return failure(id, INVALID_PARAMS, 'tools/call needs a tool name');
      try {
        const { text, isError } = callAgainstFile(path, name, params.arguments);
        return toolResult(id, text, isError);
      } catch (error) {
        // The record itself is the problem — unreadable, moved, not a record.
        // That is the user's to fix, so it reaches the assistant as a refusal,
        // not a protocol failure that leaves it guessing.
        if (error instanceof PlanError) return toolResult(id, `${error.message}. ${error.hint}`, true);
        throw error;
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized and friends
      return failure(id, METHOD_NOT_FOUND, `Unknown method ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

interface Output {
  write(chunk: string): unknown;
}

/**
 * The longest single line the transport will hold. A real message is a few KB;
 * a line that never ends is a client fault, and buffering it without limit
 * spends the user's memory answering nobody.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * One JSON message per line, UTF-8, as the stdio transport defines it. A line
 * that is not JSON is answered and the connection continues: a client that
 * sends one bad frame should not have to reconnect.
 */
export function serve(input: NodeJS.ReadableStream, output: Output, path: string): void {
  let buffer = '';
  let overlong = false;
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop() ?? ''; // whatever came after the last newline is a part-line
    if (overlong) {
      // Everything up to the next newline still belongs to the line we refused.
      if (lines.length === 0) return void (buffer = '');
      overlong = false;
      lines.shift();
    }
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let response: object | null;
      try {
        response = handle(JSON.parse(line), path);
      } catch (error) {
        response = error instanceof SyntaxError
          ? failure(null, PARSE_ERROR, 'Not valid JSON')
          : failure(null, INVALID_REQUEST, error instanceof Error ? error.message : String(error));
      }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
    // Checked on the leftover part-line, after the complete ones are answered.
    if (buffer.length > MAX_LINE_BYTES) {
      output.write(`${JSON.stringify(failure(null, INVALID_REQUEST, 'That line is too long to read'))}\n`);
      buffer = '';
      overlong = true;
    }
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP);
    return 0;
  }
  const at = argv.indexOf('--file');
  const path = at >= 0 ? argv[at + 1] : undefined;
  if (!path || path.startsWith('--')) {
    process.stderr.write('mcp-server: --file <path to health-roadmap.json> is required\n');
    return 1;
  }
  // The client closing the pipe is a normal end of session, not a crash.
  process.stdout.on('error', () => process.exit(0));
  serve(process.stdin, process.stdout, path);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
