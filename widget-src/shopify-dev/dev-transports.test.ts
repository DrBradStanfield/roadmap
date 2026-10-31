/**
 * US-20 AC5: the Shopify-like localhost reaches no production server. The
 * absolute Brad-server URLs in widget source are rewritten, in the dev build
 * only, to a prefix the dev server answers itself; Sentry stays off locally.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_BRAD_SERVER, stubResponse } from './storefront';
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

  it('the reminders and Google token calls are rewritten to the stubbed local prefix', () => {
    for (const file of ['standalone/reminders.ts', 'standalone/google-config.ts']) {
      const id = resolve(root, file);
      const source = readFileSync(id, 'utf8');
      expect(source).toMatch(/https:\/\/health-tool-app\.fly\.dev\/api\//); // the production build keeps it
      const dev = transform(source, id);
      expect(dev).not.toContain('fly.dev');
      expect(dev).toContain(`${LOCAL_BRAD_SERVER}/api/`);
    }
  });

  it('no widget source file names Brad\'s server absolutely once the dev build has read it', () => {
    const left = [...widgetSources(resolve(root, 'src')), ...widgetSources(resolve(root, 'standalone'))]
      .filter((id) => /https:\/\/(health-tool-(app|edu)\.fly\.dev|mcp\.drstanfield\.com)\//.test(transform(readFileSync(id, 'utf8'), id)));
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
