/**
 * The hosted MCP server: JSON-RPC over one HTTP POST, against the user's own
 * Dropbox folder (US-32 Phase 1, design §3/§6/§7).
 *
 * The tool layer is `packages/health-core/src/mcp-tools.ts` — the SAME five
 * pure functions the local stdio server (Phase 0) and the CLI run, so a hosted
 * call cannot invent a legal write the local path would refuse. What this file
 * adds is everything the hosted surface needs and the local one does not: a
 * bearer token to unseal, a Dropbox folder to read and write through
 * `SyncManager`, and the four MANDATORY corrections mitigations of design §3
 * — `expectedValue` required, a 90-day age limit, per-call caps, and a
 * weighted write budget.
 *
 * Deep imports into health-core, never `@roadmap/health-core`: the Fly Docker
 * build has no workspace symlink, and the package name only breaks at deploy.
 */
import { dayOf } from '../../packages/health-core/src/merge';
import { dropboxRead, dropboxWrite } from '../../packages/health-core/src/dropbox-rest';
import { SchemaTooNewError } from '../../packages/health-core/src/migrate';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';

import { StorageError, type ReadResult, type StorageAdapter, type WriteResult } from '../../packages/health-core/src/adapter';
import { SyncManager } from '../../packages/health-core/src/sync-manager';
import { callTool, isToolName, MCP_TOOLS } from '../../packages/health-core/src/mcp-tools';
import type { FileLabValue, FileMeasurement, RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import {
  dropboxAccessToken,
  isMcpEnabled,
  issuer,
  resourceUrl,
  spendWrites,
  unpackSealed,
  WRITE_COST,
  type AccessPayload,
} from './mcp-auth.server';

const PROTOCOL_VERSION = '2025-11-25';

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
// Dropbox, as a StorageAdapter
// ---------------------------------------------------------------------------

/**
 * One connection's folder, for the life of one request. The access token is
 * minted from the sealed refresh token and dies with the call; nothing is
 * cached between requests, because there is no per-user anything to cache in.
 *
 * Documents (the uploaded PDFs) are deliberately unreachable: v1 writes
 * append-only clinical values and nothing else.
 */
class HostedDropboxAdapter implements StorageAdapter {
  readonly id = 'dropbox' as const;
  readonly label = 'Dropbox';

  constructor(private readonly accessToken: string) {}

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  read(fileName: string): Promise<ReadResult> {
    return dropboxRead(this.accessToken, fileName);
  }

  write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    return dropboxWrite(this.accessToken, fileName, body, expectedVersion);
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The hosted server does not read uploaded documents.');
  }

  async writeDocument(): Promise<void> {
    throw new StorageError('The hosted server does not write uploaded documents.');
  }
}

/** Test seam: the suite hands in its own in-memory folder. */
export type AdapterFactory = (accessToken: string) => StorageAdapter;

let makeAdapter: AdapterFactory = (token) => new HostedDropboxAdapter(token);

export function setAdapterFactory(factory: AdapterFactory | null): void {
  makeAdapter = factory ?? ((token) => new HostedDropboxAdapter(token));
}

// ---------------------------------------------------------------------------
// One tool call
// ---------------------------------------------------------------------------

interface ToolAnswer {
  text: string;
  isError: boolean;
}

function refuse(text: string): ToolAnswer {
  return { text, isError: true };
}

const WRITE_TOOLS = new Set(['add_measurement', 'add_lab_values', 'correct_value']);

function writeCost(name: string): number {
  return name === 'correct_value' ? WRITE_COST.correct : WRITE_COST.add;
}

function findRow(file: RoadmapFile, id: string): FileMeasurement | FileLabValue | undefined {
  return file.measurements.find((m) => m.id === id) ?? file.labValues.find((l) => l.id === id);
}

/**
 * The two guards the hosted surface adds to `correct_value`, both mandatory
 * (design §3). Neither belongs in the tool layer: the CLI (US-31) keeps
 * `expectedValue` optional, because there a human is watching their own file.
 */
function checkCorrection(file: RoadmapFile, args: unknown, now: string): ToolAnswer | null {
  const request = (args ?? {}) as { id?: unknown; expectedValue?: unknown };
  if (typeof request.expectedValue !== 'number') {
    return refuse(
      'correct_value needs expectedValue on this server: the value you believe the row holds right now. ' +
        'Read the record, then correct. Nothing was written.',
    );
  }
  const row = typeof request.id === 'string' ? findRow(file, request.id) : undefined;
  if (!row) return null; // the tool layer answers "no such row" in its own words
  const age = daysBetween(dayOf(row.recordedAt ?? ''), dayOf(now));
  if (age > MAX_CORRECTION_AGE_DAYS) {
    return refuse(
      `That value was recorded ${age} days ago, and this server only corrects values from the last ` +
        `${MAX_CORRECTION_AGE_DAYS} days. Nothing was written. The user can correct older values in the app.`,
    );
  }
  return null;
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

/**
 * Run one tool against the user's folder: read fresh, run the tool, and only
 * if the tool produced a new file, save it through `SyncManager` — read,
 * migrate, merge, conditional write, verify. Never bypass it: the conditional
 * write with `strict_conflict` is what stops a stale write resurrecting a
 * record the user erased (design §7).
 */
export async function callHostedTool(
  token: AccessPayload,
  name: string,
  args: unknown,
  now: string,
): Promise<ToolAnswer> {
  if (!isToolName(name)) return refuse(`No tool named ${name}.`);

  const accessToken = await dropboxAccessToken(token.rt);
  if (!accessToken) {
    return refuse('Dropbox would not renew this connection. The user may have disconnected the app; ask them to reconnect.');
  }
  const sync = new SyncManager<RoadmapFile>(makeAdapter(accessToken), 'mcp', ROADMAP_DOC, () => now);

  let file: RoadmapFile;
  try {
    file = await sync.load();
  } catch (error) {
    return refuse(describeStorageFailure(error, name));
  }

  if (name === 'correct_value') {
    const refusal = checkCorrection(file, args, now);
    if (refusal) return refusal;
  }

  const isWrite = WRITE_TOOLS.has(name);
  if (isWrite && !spendWrites(token.jti, token.writes, writeCost(name))) {
    return refuse(
      'This connection has spent its write budget for now. Reading still works. The budget refreshes with the ' +
        'access token, so try again shortly, or ask the user to make this change in the app.',
    );
  }

  const outcome = callTool(name, args, { file, now });
  if (outcome.status !== 'ok') return refuse(outcome.text);
  if (!outcome.file) return { text: outcome.text, isError: false };

  try {
    await sync.save(outcome.file);
  } catch (error) {
    return refuse(describeStorageFailure(error, name));
  }
  return { text: `${outcome.text}\nSaved to the user’s Dropbox.`, isError: false };
}

/**
 * A storage failure in the agent's own terms — one error naming the provider,
 * never a retry storm. A record from a newer app version is the one case with
 * a different answer: the server reads it and refuses to write it, because
 * writing a file it only half understands is how fields get dropped.
 */
function describeStorageFailure(error: unknown, name: string): string {
  if (error instanceof SchemaTooNewError) {
    return (
      'This record was written by a newer version of the app than this server understands, so it is READ-ONLY ' +
      `here. ${name} was not run and nothing was written. Ask the user to open the app, which will update.`
    );
  }
  return 'Dropbox did not answer. Nothing was written. Try once more; if it keeps failing, the user should check dropbox.com.';
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type Id = string | number | null;

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

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
export async function handleRpc(incoming: unknown, token: AccessPayload, now: string): Promise<object | null> {
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
      const answer = await callHostedTool(token, name, params.arguments, now);
      return ok(id, { content: [{ type: 'text', text: answer.text }], ...(answer.isError ? { isError: true } : null) });
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

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return Response.json(failure(null, INVALID_REQUEST, 'Not valid JSON'), { status: 400 });
  }

  const answer = await handleRpc(body, token, now);
  if (!answer) return new Response(null, { status: 202 });
  return Response.json(answer);
}

