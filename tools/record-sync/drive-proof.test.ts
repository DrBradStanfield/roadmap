import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeDrive } from './drive-proof';

function fakeDrive(conditional: boolean, etag: string | null = '"v1"') {
  let version = 1;
  let body: unknown = { recordSyncProbe: 1, writer: 'seed' };
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    expect(address.startsWith('https://www.googleapis.com/')).toBe(true);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
    if (init?.method === 'PATCH') {
      expect(address).toContain('/upload/drive/v3/files/synthetic-id?uploadType=media');
      if (conditional && new Headers(init.headers).get('if-match') !== `"v${version}"`) {
        return new Response(null, { status: 412 });
      }
      body = JSON.parse(String(init.body)); version++;
      return Response.json({ id: 'synthetic-id', version: String(version) });
    }
    if (address.includes('alt=media')) return Response.json(body);
    return Response.json({ id: 'synthetic-id', version: String(version) }, { headers: etag ? { etag } : {} });
  });
  return { request, setBody: (value: unknown) => { body = value; } };
}

describe('US-38 AC8: opt-in synthetic Drive media-publication probe', () => {
  it('observes stale rejection after a newer write was acknowledged AND read back', async () => {
    const drive = fakeDrive(true);
    expect(await probeDrive('synthetic-id', 'synthetic-token', drive.request)).toEqual({
      observation: 'stale-write-rejected', staleStatus: 412, newerContentRetained: true, productionCleanupEnabled: false,
    });
    const methods = drive.request.mock.calls.map(([, init]) => init?.method ?? 'GET');
    expect(methods).toEqual(['GET', 'GET', 'PATCH', 'GET', 'PATCH', 'GET']);
    expect(methods).not.toContain('POST'); expect(methods).not.toContain('DELETE');
  });

  it('catches a server that accepts but ignores If-Match on media uploads', async () => {
    const drive = fakeDrive(false);
    expect(await probeDrive('synthetic-id', 'synthetic-token', drive.request)).toEqual({
      observation: 'stale-write-not-rejected', staleStatus: 200, newerContentRetained: false, productionCleanupEnabled: false,
    });
  });

  it.each([403, 429, 503])('reports stale-request HTTP %s as inconclusive, not evidence against If-Match', async status => {
    const drive = fakeDrive(true); let writes = 0;
    const request: typeof fetch = async (url, init) => {
      if (init?.method === 'PATCH' && ++writes === 2) return new Response(null, { status });
      return drive.request(url, init);
    };
    expect(await probeDrive('synthetic-id', 'synthetic-token', request)).toEqual({
      observation: 'inconclusive', staleStatus: status, newerContentRetained: true, productionCleanupEnabled: false,
    });
  });

  it.each([null, 'W/"v1"'])('does not manufacture a strong validator from version: %s', async etag => {
    const drive = fakeDrive(true, etag);
    expect((await probeDrive('synthetic-id', 'synthetic-token', drive.request)).observation).toBe('missing-strong-etag');
    expect(drive.request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each([{ schemaVersion: 1, measurements: [] }, { recordSyncProbe: 1, writer: 'seed', privateData: 'synthetic' }])('refuses any non-fixture before issuing writes', async body => {
    const drive = fakeDrive(true); drive.setBody(body);
    await expect(probeDrive('synthetic-id', 'synthetic-token', drive.request)).rejects.toThrow('Refusing');
    expect(drive.request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('rejects a malformed ID or absent token before any request', async () => {
    const drive = fakeDrive(true);
    await expect(probeDrive('../record', 'synthetic-token', drive.request)).rejects.toThrow();
    await expect(probeDrive('synthetic-id', '', drive.request)).rejects.toThrow();
    expect(drive.request).not.toHaveBeenCalled();
  });

  it('requires --live even when invoked through a symlinked absolute path', () => {
    const folder = mkdtempSync(join(tmpdir(), 'record-sync-entry-'));
    try {
      const alias = join(folder, 'probe.ts');
      symlinkSync(fileURLToPath(new URL('./drive-proof.ts', import.meta.url)), alias);
      const child = spawnSync(process.execPath, ['--import', 'tsx', alias], { encoding: 'utf8', timeout: 10_000 });
      expect(child.status).toBe(1);
      expect(child.stdout).toBe('');
      expect(child.stderr).toContain('Usage:');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
