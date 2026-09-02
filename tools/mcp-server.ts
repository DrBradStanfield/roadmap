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
import { FileAdapter } from '../packages/health-core/src/file-adapter';
import { MCP_TOOLS, runToolOverSync, type ToolAnswer } from '../packages/health-core/src/mcp-tools';
import { dispatchRpc, INVALID_REQUEST, PARSE_ERROR, PROTOCOL_VERSION, rpcFailure, SERVER_INFO, type RpcToolOutcome } from '../packages/health-core/src/mcp-rpc';
import { recordSync } from '../packages/health-core/src/roadmap-doc';
import { describeStorageFailure, isStorageFailure } from '../packages/health-core/src/sync-manager';

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
replaced atomically — the same read-merge-write path the hosted server uses
over a cloud folder. No network, no model, no telemetry.
`;

// ---------------------------------------------------------------------------
// Tool calls against the file
// ---------------------------------------------------------------------------

/**
 * One tool call against the user's file. The whole loop is `runToolOverSync`,
 * which the hosted server runs too; what is local is the adapter under it and
 * the backup line the user gets back (why: docs/mcp-architecture.md §7).
 */
async function callAgainstFile(path: string, name: string, args: unknown): Promise<ToolAnswer> {
  const now = new Date().toISOString();
  const adapter = new FileAdapter(path);
  return runToolOverSync(recordSync(adapter, 'mcp-stdio', now), name, args, now, {
    savedNote: () => `Saved (backup: ${adapter.lastBackup}).`,
  });
}

/**
 * The same call, with this surface's two failure vocabularies: the record is
 * the problem (unreadable, moved, not a record, a write that would not settle)
 * and the assistant can read that out, or it is a bug in us, which the user can
 * do nothing about and which answers -32603 on this request's own id.
 */
async function stdioTool(path: string, name: string, args: unknown): Promise<RpcToolOutcome> {
  try {
    return { answer: await callAgainstFile(path, name, args) };
  } catch (error) {
    if (isStorageFailure(error)) {
      const told = describeStorageFailure(error, path);
      return { answer: { text: `${told.message}. ${told.hint}`, isError: true } };
    }
    return { errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Answer one message, or `null` for a notification. The switch is shared. */
export function handle(incoming: unknown, path: string): Promise<object | null> {
  return dispatchRpc(incoming, {
    protocolVersion: () => PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    callTool: (name, args) => stdioTool(path, name, args),
  });
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
 *
 * Lines are answered one at a time, in order. Not for the client's sake — it
 * matches replies by id — but for the record's: two tool calls racing on one
 * file would both be legal, and the loser would spend a SyncManager retry and
 * a backup rotation on nothing.
 */
export async function serve(input: NodeJS.ReadableStream, output: Output, path: string): Promise<void> {
  let buffer = '';
  let overlong = false;
  input.setEncoding('utf8');
  for await (const chunk of input as AsyncIterable<string>) {
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop() ?? ''; // whatever came after the last newline is a part-line
    if (overlong) {
      // Everything up to the next newline still belongs to the line we refused.
      if (lines.length === 0) {
        buffer = '';
        continue;
      }
      overlong = false;
      lines.shift();
    }
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let response: object | null;
      try {
        response = await handle(JSON.parse(line), path);
      } catch (error) {
        response = error instanceof SyntaxError
          ? rpcFailure(null, PARSE_ERROR, 'Not valid JSON')
          : rpcFailure(null, INVALID_REQUEST, error instanceof Error ? error.message : String(error));
      }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
    // Checked on the leftover part-line, after the complete ones are answered.
    if (buffer.length > MAX_LINE_BYTES) {
      output.write(`${JSON.stringify(rpcFailure(null, INVALID_REQUEST, 'That line is too long to read'))}\n`);
      buffer = '';
      overlong = true;
    }
  }
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
  void serve(process.stdin, process.stdout, path);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
