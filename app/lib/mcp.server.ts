/**
 * The hosted MCP server: JSON-RPC over one HTTP POST, against the user's own
 * cloud folder — Dropbox or Google Drive (US-32 Phases 1–2, design §3/§6/§7).
 *
 * The tool layer is `packages/health-core/src/mcp-tools.ts` — the SAME pure
 * functions the local stdio server (Phase 0) and the CLI run, so a hosted
 * call cannot invent a legal write the local path would refuse. What this file
 * adds is everything the hosted surface needs and the local one does not: a
 * bearer token to unseal, a cloud folder to read and write through
 * `SyncManager`, and the four MANDATORY corrections mitigations of design §3
 * — `expectedValue` required, a 90-day age limit, per-call caps, and a
 * weighted write budget.
 *
 * Deep imports into health-core, never `@roadmap/health-core`: the Fly Docker
 * build has no workspace symlink, and the package name only breaks at deploy.
 */
import { dayOf } from '../../packages/health-core/src/merge';
import { DropboxAdapter } from '../../packages/health-core/src/dropbox-rest';
import { DriveAdapter } from '../../packages/health-core/src/drive-rest';
import { recordSync } from '../../packages/health-core/src/roadmap-doc';

import type { StorageAdapter } from '../../packages/health-core/src/adapter';
import { describeStorageFailure, isStorageFailure } from '../../packages/health-core/src/sync-manager';
import { isToolName, MCP_TOOLS, PROFILE_FIELDS, RECORD_FREE_TOOLS, runToolOverSync, type ToolAnswer } from '../../packages/health-core/src/mcp-tools';
import type { FileLabValue, FileMeasurement, RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { readCapped } from './mcp-clients.server';
import { isMcpEnabled, issuer } from './mcp-config.server';
import {
  type AccessPayload,
  allowToolCall,
  connectionKey,
  spendWrites,
  WRITE_COST,
  WRITES_PER_HOUR,
} from './mcp-grants.server';
import { type McpProvider, providerAccessToken, providerLabel } from './mcp-providers.server';
import { unpackSealed } from './mcp-seal.server';

const PROTOCOL_VERSION = '2025-11-25';

/** One JSON-RPC message. A lab panel of 50 rows is a few KB; this is slack. */
const RPC_BODY_CAP = 1024 * 1024;

/**
 * The next revision removed sessions, the GET stream, DELETE and
 * `Last-Event-ID` — every stateful mechanism, none of which we built. A
 * client announcing it may therefore skip `initialize`, and is served anyway.
 */
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2026-07-28', '2025-06-18', '2025-03-26']);

const SERVER_INFO = { name: 'health-roadmap', title: 'Health Roadmap', version: '1.0.0' };

const INSTRUCTIONS =
  'These tools read and write ONE health record — the user’s own file in their own cloud folder. Read before ' +
  'you write: values are slotted one per metric per day, and a day that already holds a value is corrected, ' +
  'never added to twice. Nothing is ever deleted; a superseded row stays as "entered-in-error". Correcting a ' +
  'value is permanent and needs the value you expect to find, so read the record first and correct only what ' +
  'the user asked you to. The plan from get_plan is educational, not medical advice, and its hedged wording ' +
  'and citations are calibrated — pass them on as written.';

/**
 * A correction fixes a recent mistake. A result from three years ago is
 * history, not a typo, so it is permanently out of reach of an agent — which
 * is what puts the bulk of the record beyond the silent-falsification attack
 * of design §3 (mitigation 2).
 */
export const MAX_CORRECTION_AGE_DAYS = 90;

// ---------------------------------------------------------------------------
// The user's folder, as a StorageAdapter
// ---------------------------------------------------------------------------

/** Test seam: the suite hands in its own in-memory folder. */
export type AdapterFactory = (provider: McpProvider, accessToken: string) => StorageAdapter;

/**
 * Which cloud comes from the sealed bearer token and nothing else — no tool
 * argument ever names a user, a file or a provider (design §4, tenant
 * isolation). Drive's adapter carries the §7 algorithm Dropbox does not need.
 */
const REAL_ADAPTER: AdapterFactory = (provider, token) =>
  provider === 'google' ? new DriveAdapter(token) : new DropboxAdapter(token);

let makeAdapter: AdapterFactory = REAL_ADAPTER;

export function setAdapterFactory(factory: AdapterFactory | null): void {
  makeAdapter = factory ?? REAL_ADAPTER;
}

// ---------------------------------------------------------------------------
// One tool call
// ---------------------------------------------------------------------------

function refuse(text: string): ToolAnswer {
  return { text, isError: true };
}

/**
 * What each write costs the hourly allowance, read off the tool table itself
 * rather than kept by hand: a tool that is not read-only spends, and one that
 * declares itself destructive spends a correction's five. Both `correct_value`
 * and `update_profile` overwrite what the record says now, which is what a
 * falsification attempt would use — so both cost the five. A new tool is
 * charged the moment it is published; there is no second list to forget.
 */
const WRITE_COSTS = new Map(
  MCP_TOOLS.filter((tool) => !tool.annotations.readOnlyHint)
    .map((tool) => [tool.name, tool.annotations.destructiveHint ? WRITE_COST.correct : WRITE_COST.add]),
);

function findRow(file: RoadmapFile, id: string): FileMeasurement | FileLabValue | undefined {
  return file.measurements.find((m) => m.id === id) ?? file.labValues.find((l) => l.id === id);
}

/**
 * The two guards the hosted surface adds to `correct_value`, both mandatory
 * (design §3). Neither belongs in the tool layer: the CLI (US-31) keeps
 * `expectedValue` optional, because there a human is watching their own file.
 */
function checkCorrection(file: RoadmapFile, args: unknown, now: string): string | null {
  const request = (args ?? {}) as { id?: unknown; expectedValue?: unknown };
  if (typeof request.expectedValue !== 'number') {
    return (
      'correct_value needs expectedValue on this server: the value you believe the row holds right now. ' +
      'Read the record, then correct. Nothing was written.'
    );
  }
  const row = typeof request.id === 'string' ? findRow(file, request.id) : undefined;
  if (!row) return null; // the tool layer answers "no such row" in its own words
  // UTC by choice: the server has no user timezone; both sides are calendar days.
  const age = daysBetween(dayOf(row.recordedAt ?? ''), dayOf(now));
  if (age > MAX_CORRECTION_AGE_DAYS) {
    return (
      `That value was recorded ${age} days ago, and this server only corrects values from the last ` +
      `${MAX_CORRECTION_AGE_DAYS} days. Nothing was written. The user can correct older values in the app.`
    );
  }
  return null;
}

/**
 * The same guard for `update_profile` (US-34): every field the call changes
 * must come with the value the agent believes it is replacing. The profile is
 * last-write-wins, so there is no superseded copy to read back — the claim is
 * the only thing standing between a stale read and a silently wrong plan.
 */
function checkProfileUpdate(args: unknown): string | null {
  const request = (args ?? {}) as Record<string, unknown>;
  const expected = (request.expected ?? {}) as Record<string, unknown>;
  const missing = PROFILE_FIELDS.filter((field) => request[field] !== undefined && expected[field] === undefined);
  if (missing.length === 0) return null;
  return (
    `update_profile needs expected.${missing.join(', expected.')} on this server: the value you believe the record ` +
    'holds now, or null if it holds none. Read the record, then update. Nothing was written.'
  );
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

/**
 * Everything this surface adds before a tool runs: the two corrections guards
 * of design §3, and the weighted write budget. It is charged HERE, ahead of
 * the tool, so a refused write still costs its allowance — an agent probing
 * `expectedValue` for a value it does not know must pay per attempt (§3,
 * mitigation 4). The loop itself is `runToolOverSync`, shared with the stdio
 * server (docs §7).
 */
function beforeHostedCall(token: AccessPayload, name: string, file: RoadmapFile, args: unknown, now: string): string | null {
  if (name === 'correct_value') {
    const refusal = checkCorrection(file, args, now);
    if (refusal) return refusal;
  }
  if (name === 'update_profile') {
    const refusal = checkProfileUpdate(args);
    if (refusal) return refusal;
  }
  const cost = WRITE_COSTS.get(name);
  if (cost !== undefined && !spendWrites(connectionKey(token.rt), cost)) {
    return (
      `This connection has spent its write allowance for the hour — ${WRITES_PER_HOUR} weighted writes an hour, ` +
      `where a correction counts as ${WRITE_COST.correct}. Reading still works. The allowance comes back with ` +
      'the hour; a new access token does not buy more. Ask the user to make this change in the app if it cannot wait.'
    );
  }
  return null;
}

/**
 * Run one tool against the user's folder. Never bypass `SyncManager`: the
 * conditional write with `strict_conflict` is what stops a stale write
 * resurrecting a record the user erased (design §7).
 */
async function callHostedTool(
  token: AccessPayload,
  name: string,
  args: unknown,
  now: string,
): Promise<ToolAnswer> {
  if (!isToolName(name)) return refuse(`No tool named ${name}.`);

  const provider = providerLabel(token.provider);

  // Record-free tools open nothing, exactly as the stdio server runs them: the
  // likeliest moment to report a bug is the moment the record would not open,
  // so `report_feedback` must not need the provider — nor a token minted for it.
  let accessToken = '';
  if (!RECORD_FREE_TOOLS.has(name)) {
    const minted = await providerAccessToken(token.provider, token.rt);
    if (!minted) {
      return refuse(
        `${provider} would not renew this connection, so nothing was read and nothing was written. Either the user ` +
          `disconnected the app or ${provider} could not be reached; ask them to try again, and to reconnect if it persists.`,
      );
    }
    accessToken = minted;
  }

  try {
    return await runToolOverSync(recordSync(makeAdapter(token.provider, accessToken), 'mcp', now), name, args, now, {
      beforeCall: (file) => beforeHostedCall(token, name, file, args, now),
      savedNote: () => `Saved to the user’s ${provider}.`,
    });
  } catch (error) {
    // Storage is allowed to fail, and the user can act on that, so it is worded
    // as a refusal. Anything else is a bug in us: dressing one up as "the
    // record did not answer" sends the user to check a cloud folder that is
    // perfectly fine. It is rethrown instead, and `handleRpc` turns it into
    // -32603 on this request's id — exactly what the stdio server does.
    if (!isStorageFailure(error)) {
      // The name alone. No args, no values, no message: health data never
      // enters a log.
      console.error('[mcp] tool failed', name, error instanceof Error ? error.name : 'unknown');
      throw error;
    }
    const failed = describeStorageFailure(error, `The record in ${provider}`);
    return refuse(`${failed.message}. ${failed.hint}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type Id = string | number | null;

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: Id, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id: Id, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Answer one JSON-RPC message, or `null` for a notification. Nothing is
 * remembered between messages: a client that skips `initialize` is served,
 * which is what the next protocol revision expects anyway.
 */
async function handleRpc(incoming: unknown, token: AccessPayload, now: string): Promise<object | null> {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return failure(null, INVALID_REQUEST, 'A request must be a JSON object');
  }
  const message = incoming as { id?: Id; method?: unknown; params?: unknown };
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (!method) return isNotification ? null : failure(id, INVALID_REQUEST, 'A request needs a method');

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return failure(id, INVALID_PARAMS, 'tools/call needs a tool name');
      // Per connection: every tool call refreshes a provider access token under
      // our one shared app identity, so a loop here is a loop at the provider.
      if (!allowToolCall(connectionKey(token.rt))) {
        return ok(id, {
          content: [{ type: 'text', text: 'Too many tool calls from this connection in the last minute. Wait a moment, then try again.' }],
          isError: true,
        });
      }
      // A bug in us must reach the client as an error carrying THIS request's
      // id, never as a 500 the vendor cannot match to anything — the stdio
      // server has answered this way since phase 0. Storage failures are
      // already words by here; what lands in this catch is ours.
      let answer: ToolAnswer;
      try {
        answer = await callHostedTool(token, name, params.arguments, now);
      } catch {
        return failure(id, INTERNAL_ERROR, 'That tool failed inside this server. Nothing was written.');
      }
      return ok(id, {
        content: [{ type: 'text', text: answer.text }],
        // Declared `outputSchema` obliges an OK result to carry the structured
        // answer too; a refusal is an error result and carries none.
        ...(answer.structured === undefined ? null : { structuredContent: answer.structured }),
        ...(answer.isError ? { isError: true } : null),
      });
    }
    default:
      return isNotification ? null : failure(id, METHOD_NOT_FOUND, `Unknown method ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * MCP clients are servers, not browsers: nothing here ever emits a CORS
 * header, `ALLOWED_ORIGINS` is untouched, and a present-but-foreign `Origin`
 * is a browser that has no business here (design §6).
 */
export function originRejected(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin !== null && origin !== issuer();
}

/**
 * The 401 Claude needs to start OAuth. It ignores this header on a 200, so the
 * unauthenticated answer must be a real 401 with the PRM pointer on it.
 */
export function unauthorized(): Response {
  return Response.json(
    { error: 'invalid_token', error_description: 'A bearer token is required' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`,
      },
    },
  );
}

function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * The whole `/mcp` endpoint. GET and DELETE are 405 — we have no event stream
 * and no session to delete — and `Mcp-Session-Id` is never minted; an incoming
 * one, like `Last-Event-ID`, is ignored.
 */
export async function mcpEndpoint(request: Request, now = new Date().toISOString()): Promise<Response> {
  if (!isMcpEnabled()) return new Response('Not found', { status: 404 });
  if (originRejected(request)) return new Response('Forbidden', { status: 403 });
  if (request.method !== 'POST') {
    return Response.json({ error: 'Use POST' }, { status: 405, headers: { Allow: 'POST' } });
  }

  const presented = bearer(request);
  if (!presented) return unauthorized();
  const token = unpackSealed<AccessPayload>('access', presented);
  if (!token) return unauthorized();

  let text: string;
  try {
    text = await readCapped(request, RPC_BODY_CAP);
  } catch {
    return Response.json(failure(null, INVALID_REQUEST, 'That request body is too large'), { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(failure(null, INVALID_REQUEST, 'Not valid JSON'), { status: 400 });
  }

  const answer = await handleRpc(body, token, now);
  if (!answer) return new Response(null, { status: 202 });
  return Response.json(answer);
}

