import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentRef } from '@roadmap/health-core';
import { GitHubAdapter } from './github';
import { WebDavAdapter } from './webdav';

const githubConfig = { token: 'synthetic-placeholder', owner: 'synthetic', repo: 'private-record' };
const repoUrl = 'https://api.github.com/repos/synthetic/private-record';
const refs = [
  buildDocumentRef({ type: 'clinic_letter', title: 'Letter #1', date: '2026-01-01', sourceFileName: 'synthetic.pdf', existingRefs: [] }),
  'documents/nested folder/100% literal %23 #1 résumé 日本語.pdf',
  'documents/literal %23.pdf',
  'documents/100%.pdf',
  'documents/space résumé 日本語.pdf',
  'documents/lab.pdf',
];
const malformedRefs = [
  [buildDocumentRef({ type: 'clinic_letter', title: 'a'.repeat(64) + '😀', date: '2026-01-01', sourceFileName: 'synthetic.pdf', existingRefs: [] }), `Clinic%20letters/2026-01-01%20${'a'.repeat(64)}%EF%BF%BD.pdf`],
  ['documents/\ud800.pdf', 'documents/%EF%BF%BD.pdf'],
  ['documents/\udc00.pdf', 'documents/%EF%BF%BD.pdf'],
  ['documents/😀.pdf', 'documents/%F0%9F%98%80.pdf'],
  ['documents/\ufeff.pdf', 'documents/%EF%BB%BF.pdf'],
] as const;
it.each(malformedRefs)('US-14 AC1: preserves URL string conversion for generated or malformed ref %s', async (ref, escaped) => {
  for (const kind of ['github', 'webdav'] as const) {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      if (request.url === repoUrl) return json({ private: true });
      paths.push(new URL(request.url).pathname);
      return kind === 'github' ? json(request.method === 'PUT' ? {content:{sha:'new'}} : {content:btoa('synthetic'),sha:'old'}) : new Response('synthetic');
    }));
    const adapter = kind === 'github' ? new GitHubAdapter(githubConfig) : new WebDavAdapter({...davConfig,url:davBase});
    await adapter.readDocument(ref);
    await adapter.writeDocument(ref,new Blob(['synthetic']));
    const prefix = kind === 'github' ? '/repos/synthetic/private-record/contents/' : '/dav/base%20folder/literal%23/%2523/';
    expect(paths).toEqual([prefix+escaped,prefix+escaped]);
  }
});
const encoded = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const davBase = 'https://synthetic.invalid/dav/base%20folder/literal%23/%2523';
const davConfig = { username: 'synthetic', password: 'synthetic-placeholder' };

// US-14 AC1: refs stay logical paths; only the HTTP boundary escapes them.
// All HTTP is mocked: these assertions prove request construction, not provider acceptance.
describe.each([davBase, `${davBase}/`])('WebDAV document request paths with base %s', (base) => {
  it('keeps base escaping and the collection slash through PROPFIND and a missing-parent retry', async () => {
    const ref = refs[1];
    const requests: Request[] = [];
    let puts = 0;
    vi.stubGlobal('localStorage', { setItem: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.method === 'PUT' && ++puts === 1) return new Response('', { status: 409 });
      return new Response('', { status: request.method === 'PROPFIND' ? 207 : 201 });
    }));
    const adapter = new WebDavAdapter({ ...davConfig, url: base });
    await adapter.connect();
    await adapter.writeDocument(ref, new Blob(['synthetic']));
    const expectedUrl = `${davBase}/${encoded(ref)}`;
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['PROPFIND', `${davBase}/`], ['PUT', expectedUrl],
      ['MKCOL', `${davBase}/documents/nested%20folder/`], ['PUT', expectedUrl],
    ]);
    expect(requests[0].headers.get('depth')).toBe('0');
    expect(await requests[1].text()).toBe('synthetic');
    expect(await requests[3].text()).toBe('synthetic');
  });

  it.each(refs)('reads and writes the literal document ref %s', async (ref) => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return new Response('synthetic bytes');
    }));
    const adapter = new WebDavAdapter({ ...davConfig, url: base });
    expect(await (await adapter.readDocument(ref)).text()).toBe('synthetic bytes');
    await adapter.writeDocument(ref, new Blob(['synthetic bytes']));
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', `${davBase}/${encoded(ref)}`],
      ['PUT', `${davBase}/${encoded(ref)}`],
    ]);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.hash).toBe('');
      expect(url.search).toBe('');
      expect(decodeURIComponent(url.pathname)).toBe(`/dav/base folder/literal#/%23/${ref}`);
    }
    expect(await requests[1].text()).toBe('synthetic bytes');
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

// US-14 AC1: refs stay logical paths; only the HTTP boundary escapes them.
// All HTTP is mocked: these assertions prove request construction, not provider acceptance.
describe('GitHub document request paths', () => {
  it.each([409, 422])('uses the same escaped path on a %s SHA retry without choosing a branch', async (status) => {
    const ref = refs[1];
    const requests: Request[] = [];
    let puts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.url === repoUrl) return json({ private: true });
      if (request.method === 'PUT') return ++puts === 1 ? json({}, status) : json({ content: { sha: 'new-sha' } });
      return json({ sha: 'current-sha' });
    }));
    await new GitHubAdapter(githubConfig).writeDocument(ref, new Blob(['synthetic']));
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', repoUrl],
      ['PUT', `${repoUrl}/contents/${encoded(ref)}`],
      ['GET', `${repoUrl}/contents/${encoded(ref)}`],
      ['PUT', `${repoUrl}/contents/${encoded(ref)}`],
    ]);
    expect(await requests[1].json()).toEqual({ message: `Update ${ref}`, content: btoa('synthetic') });
    expect(await requests[3].json()).toEqual({ message: `Update ${ref}`, content: btoa('synthetic'), sha: 'current-sha' });
  });

  it('keeps record versions and default-branch request semantics', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.url === repoUrl) return json({ private: true });
      return request.method === 'PUT' ? json({ content: { sha: 'new-sha' } }) : json({ content: btoa('{}'), sha: 'old-sha' });
    }));
    const adapter = new GitHubAdapter(githubConfig);
    const read = await adapter.read('health-roadmap.json');
    expect(read).toEqual({ body: {}, version: 'old-sha' });
    expect(await adapter.write('health-roadmap.json', { synthetic: true }, read.version)).toEqual({ version: 'new-sha' });
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', `${repoUrl}/contents/health-roadmap.json`], ['GET', repoUrl], ['PUT', `${repoUrl}/contents/health-roadmap.json`],
    ]);
    expect(await requests[2].json()).toEqual({ message: 'Update health-roadmap.json', content: btoa('{"synthetic":true}'), sha: 'old-sha' });
    expect(requests[2].headers.get('x-github-api-version')).toBe('2022-11-28');
  });

  it.each([false, undefined])('still refuses document PUTs unless private is true (%s)', async (isPrivate) => {
    const fetchMock = vi.fn(async () => json({ private: isPrivate }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GitHubAdapter(githubConfig).writeDocument(refs[1], new Blob(['synthetic'])))
      .rejects.toThrow(/repository is public/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(repoUrl, expect.any(Object));
  });

  it.each(refs)('reads and writes the literal document ref %s', async (ref) => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.url === repoUrl) return json({ private: true });
      return request.method === 'PUT' ? json({ content: { sha: 'new-sha' } }) : json({ content: btoa('synthetic bytes'), sha: 'old-sha' });
    }));
    const adapter = new GitHubAdapter(githubConfig);
    expect(await (await adapter.readDocument(ref)).text()).toBe('synthetic bytes');
    await adapter.writeDocument(ref, new Blob(['synthetic bytes']));
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', `${repoUrl}/contents/${encoded(ref)}`],
      ['GET', repoUrl],
      ['PUT', `${repoUrl}/contents/${encoded(ref)}`],
    ]);
    for (const request of [requests[0], requests[2]]) {
      const url = new URL(request.url);
      expect(url.hash).toBe('');
      expect(url.search).toBe('');
      expect(decodeURIComponent(url.pathname)).toBe(`/repos/synthetic/private-record/contents/${ref}`);
    }
    const payload = await requests[2].json();
    expect(payload).toEqual({ message: `Update ${ref}`, content: btoa('synthetic bytes') });
    expect(refs[0]).toContain('Letter #1.pdf');
  });
});

// US-14 AC1: documents written before PR #186 sit where the raw ref resolved
// (everything from `#` dropped, `%xx` text decoded by the server). A read 404 at
// the encoded URL retries once there. The fake server stores by decoded path.
describe.each(['github', 'webdav'] as const)('legacy document reads (%s)', (kind) => {
  const base = kind === 'github' ? `${repoUrl}/contents/` : `${davBase}/`;
  const serve = (stored: Map<string, string>, requests: string[]) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request.url);
      const body = stored.get(decodeURIComponent(new URL(request.url).pathname));
      if (body === undefined) return new Response('', { status: 404 });
      return kind === 'github' ? json({ content: btoa(body), sha: 'old-sha' }) : new Response(body);
    }));
  const adapter = () => kind === 'github' ? new GitHubAdapter(githubConfig) : new WebDavAdapter({ ...davConfig, url: davBase });

  it.each([
    [refs[0], 'Clinic letters/2026-01-01 Letter ', 'Clinic%20letters/2026-01-01%20Letter%20'],
    ['documents/literal %20.pdf', 'documents/literal  .pdf', 'documents/literal%20%20.pdf'],
  ])('reads %s from its pre-encoding location', async (ref, legacyPath, legacyUrlPath) => {
    const requests: string[] = [];
    serve(new Map([[decodeURIComponent(new URL(base).pathname) + legacyPath, 'legacy bytes']]), requests);
    expect(await (await adapter().readDocument(ref)).text()).toBe('legacy bytes');
    expect(requests).toEqual([base + encoded(ref), base + legacyUrlPath]);
  });

  it('makes no second request for a plain ref', async () => {
    const requests: string[] = [];
    serve(new Map(), requests);
    await expect(adapter().readDocument('documents/space résumé.pdf')).rejects.toThrow(/404/);
    expect(requests).toHaveLength(1);
  });
});
