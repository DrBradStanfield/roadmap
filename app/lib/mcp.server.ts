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
import { dayOf, latestDayOnEarth } from '../../packages/health-core/src/merge';
import { DropboxAdapter } from '../../packages/health-core/src/dropbox-rest';
import { DriveAdapter } from '../../packages/health-core/src/drive-rest';
import { recordSync } from '../../packages/health-core/src/roadmap-doc';

import { StorageError, type StorageAdapter } from '../../packages/health-core/src/adapter';
import { describeStorageFailure, isStorageFailure } from '../../packages/health-core/src/sync-manager';
import { isToolName, MCP_TOOLS, PROFILE_FIELDS, RECORD_FREE_TOOLS, runToolOverSync, type ToolAnswer } from '../../packages/health-core/src/mcp-tools';
import { dispatchRpc, INVALID_REQUEST, PROTOCOL_VERSION, rpcFailure, SERVER_INFO, type RpcToolOutcome } from '../../packages/health-core/src/mcp-rpc';
import { MCP_TOOL_NAMES, type McpToolName } from '../../packages/health-core/src/product-events';
import { KNOWN_CLIENTS, readCapped, type McpClientLabel } from './mcp-clients.server';
import { hostedImporter } from './mcp-import.server';
import { recordServerEvent } from './product-events.server';
import type { FileLabValue, FileMeasurement, RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { githubFiler } from './github-issues.server';
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

/** One JSON-RPC message. A lab panel of 50 rows is a few KB; this is slack. */
const RPC_BODY_CAP = 1024 * 1024;

/**
 * The next revision removed sessions, the GET stream, DELETE and
 * `Last-Event-ID` — every stateful mechanism, none of which we built. A
 * client announcing it may therefore skip `initialize`, and is served anyway.
 */
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-06-18', '2025-03-26']);

const INSTRUCTIONS =
  'These tools read and write ONE health record — the user’s own file in their own cloud folder. Read before ' +
  'you write: values are slotted one per metric per day, and a day that already holds a value is corrected, ' +
  'never added to twice. Nothing is ever deleted; a superseded row stays as "entered-in-error". Correcting a ' +
  'value is permanent and needs the value you expect to find, so read the record first and correct only what ' +
  'the user asked you to. The plan from get_plan is educational, not medical advice, and its hedged wording ' +
  'and citations are calibrated — pass them on as written. import_documents reads lab files and writes nothing ' +
  'until its commit, which needs the user’s own confirmation of what it found.';

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

/** What each write costs the hourly allowance, read off each tool's own
 *  `cost` — never `annotations`, which are hints a client may not trust (C4). */
const WRITE_COSTS = new Map(
  MCP_TOOLS.flatMap((tool) => (tool.cost === 'none' ? [] : [[tool.name, WRITE_COST[tool.cost]] as const])),
);

function findRow(file: RoadmapFile, id: string): FileMeasurement | FileLabValue | undefined {
  return file.measurements.find((m) => m.id === id) ?? file.labValues.find((l) => l.id === id);
}

/**
 * The two guards the hosted surface adds to `correct_value`, both mandatory
 * (design §3). Neither belongs in the tool layer: the CLI (US-31) keeps
 * `expectedValue` optional, because there a human is watching their own file.
 */
export function checkCorrection(file: RoadmapFile, args: unknown, now: string): string | null {
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
  return chargeWrites(token, name);
}

/**
 * The weighted write budget, charged before the tool runs so a refused write
 * still costs its allowance — free guesses at a value an agent does not know
 * ARE the falsification attack (§3, mitigation 4). Split out because
 * `report_feedback` opens no record and so never reaches `beforeCall`, and an
 * uncharged tool that writes to a public issue tracker is a megaphone.
 */
function chargeWrites(token: AccessPayload, name: string): string | null {
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
  if (RECORD_FREE_TOOLS.has(name)) {
    const refusal = chargeWrites(token, name);
    if (refusal) return refuse(refusal);
  } else {
    const minted = await providerAccessToken(token.provider, token.rt);
    if (!minted) {
      return refuse(
        `${provider} would not renew this connection, so nothing was read and nothing was written. Either the user ` +
          `disconnected the app or ${provider} could not be reached; ask them to try again, and to reconnect if it persists.`,
      );
    }
    accessToken = minted;
  }

  const adapter = makeAdapter(token.provider, accessToken);
  try {
    return await runToolOverSync(recordSync(adapter, 'mcp', now), name, args, now, {
      beforeCall: (file) => beforeHostedCall(token, name, file, args, now),
      // This server runs in UTC and cannot know the user's timezone, so the
      // future check is the widest day anyone has reached (US-31 AC6/AC11).
      latestDay: latestDayOnEarth(now),
      savedNote: () => `Saved to the user’s ${provider}.`,
      // With no GitHub token configured the tool falls back to a prefilled URL
      // the user submits — which is all the stdio server can ever do.
      fileFeedback: name === 'report_feedback' ? (githubFiler(token.provider, connectionKey(token.rt)) ?? undefined) : undefined,
      // The import reads files through the user's own folder and parks its
      // candidates there; its guards and charges live inside (US-35).
      importer: name === 'import_documents'
        ? hostedImporter({ token, accessToken, adapter, client: mcpClientLabel(token.clientId), checkCorrection, maxCorrectionAgeDays: MAX_CORRECTION_AGE_DAYS })
        : undefined,
    });
  } catch (error) {
    // Storage is allowed to fail, and the user can act on that, so it is worded
    // as a refusal. Anything else is a bug in us: dressing one up as "the
    // record did not answer" sends the user to check a cloud folder that is
    // perfectly fine. It is rethrown instead, and the dispatch turns it into
    // -32603 on this request's id — exactly what the stdio server does. The
    // failure is counted there, as `outcome: 'error'`; nothing is logged,
    // because health data never enters a log.
    if (!isStorageFailure(error)) throw error;
    // A rejected access token is not an unreachable folder: the refresh
    // worked, so the grant is alive, but this token buys nothing — a scope
    // change, or the app folder removed. Read off the status the adapter kept,
    // never the message text.
    if (error instanceof StorageError && (error.status === 401 || error.status === 403)) {
      return refuse(
        `${provider} refused this connection’s access to the record. Nothing was read and nothing was written. ` +
          'Ask the user to reconnect the connector, which grants it again.',
      );
    }
    const failed = describeStorageFailure(error, `The record in ${provider}`);
    return refuse(`${failed.message}. ${failed.hint}`);
  }
}

// ---------------------------------------------------------------------------
// Telemetry — how much the connector is used, never what it holds
// ---------------------------------------------------------------------------

/** Which assistant is calling, read off the pinned client table's own label. */
export function mcpClientLabel(clientId: string): McpClientLabel {
  return KNOWN_CLIENTS.get(clientId)?.label ?? 'other';
}

/** One counter row per tool call: which tool, which assistant, whether it
 *  worked. Why it carries nothing else: docs/mcp-architecture.md §8. */
function countToolCall(clientId: string, tool: string, outcome: 'ok' | 'refused' | 'error'): void {
  // A name that is not a published tool was never a tool call, and free text
  // in a counter is how a counter becomes a log.
  if (!(MCP_TOOL_NAMES as readonly string[]).includes(tool)) return;
  void recordServerEvent('mcp_tool_call', { tool: tool as McpToolName, client: mcpClientLabel(clientId), outcome });
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

/**
 * The hosted surface's half of the shared dispatch (`mcp-rpc.ts`): a
 * negotiated protocol version, this server's identity, and a tool call with
 * the per-connection rate limit around it. Everything else — the method
 * switch, the envelopes, the error codes — is the same code the stdio server
 * runs, so the two cannot answer differently.
 */
function hostedSurface(token: AccessPayload, now: string) {
  return {
    protocolVersion: (asked: string) => (SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION),
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    async callTool(name: string, args: unknown): Promise<RpcToolOutcome> {
      // Per connection: every tool call refreshes a provider access token under
      // our one shared app identity, so a loop here is a loop at the provider.
      // Not counted: a client stuck in a loop would otherwise write the
      // counter thousands of times and drown the tool it is looping on.
      if (!allowToolCall(connectionKey(token.rt))) {
        return {
          answer: {
            text: 'Too many tool calls from this connection in the last minute. Wait a moment, then try again.',
            isError: true,
          },
        };
      }
      // A bug in us must reach the client as an error carrying THIS request's
      // id, never as a 500 the vendor cannot match to anything — the stdio
      // server has answered this way since phase 0. Storage failures are
      // already words by here; what lands in this catch is ours.
      try {
        const answer = await callHostedTool(token, name, args, now);
        countToolCall(token.clientId, name, answer.isError ? 'refused' : 'ok');
        return { answer };
      } catch {
        countToolCall(token.clientId, name, 'error');
        return { errorMessage: 'That tool failed inside this server. Nothing was written.' };
      }
    },
  };
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
    return Response.json(rpcFailure(null, INVALID_REQUEST, 'That request body is too large'), { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json(rpcFailure(null, INVALID_REQUEST, 'Not valid JSON'), { status: 400 });
  }

  const answer = await dispatchRpc(body, hostedSurface(token, now));
  if (!answer) return new Response(null, { status: 202 });
  return Response.json(answer);
}

