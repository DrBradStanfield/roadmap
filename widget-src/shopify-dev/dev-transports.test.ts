/**
 * US-20 AC5: the Shopify-like localhost reaches no production server. The
 * absolute Brad-server URLs in widget source are rewritten, in the dev build
 * only, to a prefix the dev server answers itself; Sentry stays off locally.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BRAD_SERVER_PATTERN, LOCAL_BRAD_SERVER, stubResponse } from './storefront';
import { shopifyDev } from '../vite.config.shopify-dev';
import { isLoopbackHost } from '../src/lib/sentry';

/** Every non-test source file the widget build can load. */
function widgetSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : widgetSources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('US-20 AC5: dev:shopify keeps every call to Brad\'s server local', () => {
  const plugin = shopifyDev();
  const transform = (code: string, id: string) => {
    const hook = plugin.transform as (code: string, id: string) => { code: string } | null;
    return hook(code, id)?.code ?? code;
  };
  const root = resolve(__dirname, '..');

  it('the reminders and Google token calls are rewritten to the stubbed local prefix', async () => {
    // One origin constant names the server; the production build keeps it.
    const originId = resolve(root, 'standalone/server-origin.ts');
    const origin = readFileSync(originId, 'utf8');
    expect(origin).toContain("BRAD_SERVER_ORIGIN = 'https://health-tool-app.fly.dev'");
    const devOrigin = transform(origin, originId);
    expect(devOrigin).not.toContain('fly.dev');
    expect(devOrigin).toContain(`BRAD_SERVER_ORIGIN = '${LOCAL_BRAD_SERVER}'`);

    // Both calls build their URL from it, and name no server of their own.
    for (const [file, path] of [['standalone/reminders.ts', '/api/reminders-v2'], ['standalone/google-config.ts', '/api/google-token']]) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source).toContain(`\${BRAD_SERVER_ORIGIN}${path}`);
      expect(source).not.toContain('fly.dev');
    }

    // The real Google config, given the dev build's constant, calls the stub.
    vi.resetModules();
    vi.doMock('../standalone/server-origin', () => ({ BRAD_SERVER_ORIGIN: LOCAL_BRAD_SERVER }));
    vi.stubGlobal('location', { origin: 'http://localhost:5173', pathname: '/' });
    try {
      const { googleDriveConfig } = await import('../standalone/google-config');
      const { exchangeUrl } = googleDriveConfig();
      expect(exchangeUrl).toBe(`${LOCAL_BRAD_SERVER}/api/google-token`);
      expect(stubResponse('POST', exchangeUrl!)?.status).toBe(503);
    } finally {
      vi.doUnmock('../standalone/server-origin');
      vi.unstubAllGlobals();
    }
  });

  it('no widget source file names Brad\'s server absolutely once the dev build has read it', () => {
    const left = [...widgetSources(resolve(root, 'src')), ...widgetSources(resolve(root, 'standalone'))]
      .filter((id) => BRAD_SERVER_PATTERN.test(transform(readFileSync(id, 'utf8'), id)));
    expect(left).toEqual([]);
  });

  it('the dev server answers those calls itself, and passes everything else on', () => {
    expect(stubResponse('POST', `${LOCAL_BRAD_SERVER}/api/reminders-v2`)?.status).toBe(503);
    expect(stubResponse('POST', `${LOCAL_BRAD_SERVER}/api/google-token`)?.status).toBe(503);
    expect(stubResponse('POST', '/apps/health-tool-1/api/events')).toEqual({ status: 200, body: { success: true } });
    expect(stubResponse('GET', '/standalone/app.tsx')).toBeNull();
  });

  it('Sentry treats every loopback host as development', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['drstanfield.com', 'notlocalhost.com', 'drbradstanfield.github.io']) expect(isLoopbackHost(host)).toBe(false);
  });
});
