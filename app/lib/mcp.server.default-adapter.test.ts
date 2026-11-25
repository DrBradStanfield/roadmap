/**
 * US-32 phase 2 · the hosted endpoint with NO wiring builds the real adapter for
 * the sealed provider, and only that. The network is stubbed at `fetch`, so what
 * is pinned is what the caller sees: the adapter class built with the minted
 * access token, the URLs hit and the answer text (T29: the factory moved from
 * module state to the endpoint's `wiring` argument).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const built = vi.hoisted(() => [] as string[]);
vi.mock('../../packages/health-core/src/dropbox-rest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../packages/health-core/src/dropbox-rest')>();
  class DropboxAdapter extends original.DropboxAdapter {
    constructor(...args: ConstructorParameters<typeof original.DropboxAdapter>) {
      super(...args);
      built.push(`DropboxAdapter(${args[0]})`);
    }
  }
  return { ...original, DropboxAdapter };
});
vi.mock('../../packages/health-core/src/drive-rest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../packages/health-core/src/drive-rest')>();
  class DriveAdapter extends original.DriveAdapter {
    constructor(...args: ConstructorParameters<typeof original.DriveAdapter>) {
      super(...args);
      built.push(`DriveAdapter(${args[0]})`);
    }
  }
  return { ...original, DriveAdapter };
});

import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';
import { resetMcpMemory } from './mcp-grants.server';
import { packSealed } from './mcp-seal.server';
import { mcpEndpoint } from './mcp.server';

const ISSUER = 'https://mcp.example.test';
const NOW = '2026-09-02T10:00:00.000Z';

beforeEach(() => {
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 8).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  process.env.GOOGLE_DRIVE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_DRIVE_SECRET = 'google-secret';
  resetMcpMemory();
  built.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_SECRET;
});

/** A sealed access token for this provider, as `/mcp/token` mints it. */
function access(provider: 'dropbox' | 'google'): string {
  return packSealed('access', 'client', { clientId: 'client', provider, rt: `${provider}-refresh`, exp: Math.floor(Date.now() / 1000) + 3600 });
}

/** One fixed tools/call, exactly as a route hands it over: no wiring. */
async function call(provider: 'dropbox' | 'google', name: string) {
  const res = await mcpEndpoint(
    new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access(provider)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
    }),
    NOW,
  );
  expect(res.status).toBe(200);
  const answer = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: answer.result.content[0].text, isError: answer.result.isError === true };
}

describe('T29 · with no wiring the endpoint builds the real adapter for the sealed provider', () => {
  it('Dropbox: a DropboxAdapter on the minted token reads the record over the Dropbox REST API', async () => {
    const hit: string[] = [];
    const file = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      hit.push(`${url.host}${url.pathname}`);
      if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'dropbox-access' });
      if (url.pathname === '/2/files/download') {
        return new Response(JSON.stringify(file), { headers: { 'dropbox-api-result': '{"rev":"1"}' } });
      }
      return Response.json({ entries: [], has_more: false });
    }));

    const answer = await call('dropbox', 'read_record');

    expect(answer.isError).toBe(false);
    expect(built).toEqual(['DropboxAdapter(dropbox-access)']);
    expect([...new Set(hit)].sort()).toMatchInlineSnapshot(`
      [
        "api.dropboxapi.com/2/files/list_folder",
        "api.dropboxapi.com/oauth2/token",
        "content.dropboxapi.com/2/files/download",
      ]
    `);
  });

  it('Google: a DriveAdapter on the minted token opens the record over the Drive REST API, and the folder import is refused', async () => {
    const hit: string[] = [];
    const file = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      hit.push(`${url.host}${url.pathname}`);
      if (url.host === 'oauth2.googleapis.com') return Response.json({ access_token: 'google-access', expires_in: 3600 });
      if (url.pathname === '/drive/v3/files') {
        const q = decodeURIComponent(url.searchParams.get('q') ?? '');
        return Response.json({ files: q.includes(ROADMAP_FILE_NAME) ? [{ id: 'file-1' }] : [{ id: 'folder-1' }] });
      }
      if (url.pathname === '/drive/v3/files/file-1') {
        return url.searchParams.get('alt') === 'media' ? new Response(JSON.stringify(file)) : Response.json({ version: '7' });
      }
      return new Response('unexpected', { status: 500 });
    }));

    const answer = await call('google', 'import_documents');

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatchInlineSnapshot(`"This record lives in Google Drive, and the permission the connector holds cannot see files dropped into the folder. Upload it on the website, which reads the PDF in your browser and files it into the same record. Nothing was read."`);
    expect(built).toEqual(['DriveAdapter(google-access)']);
    expect([...new Set(hit)].sort()).toMatchInlineSnapshot(`
      [
        "oauth2.googleapis.com/token",
        "www.googleapis.com/drive/v3/files",
        "www.googleapis.com/drive/v3/files/file-1",
      ]
    `);
  });
});
