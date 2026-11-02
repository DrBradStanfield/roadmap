/**
 * US-61 AC5 — Brad's products reach the Shopify build only. The widget imports
 * us-products.ts beside a SHOPIFY_SURFACE gate, so the GitHub Pages build must
 * tree-shake it away. This builds the Pages app in memory and greps every file
 * it would publish, sourcemaps included (pages.yml uploads them, and their
 * sourcesContent carries comments), for the product text. The committed
 * Shopify bundle is the control: the same grep must find it there, or the
 * markers have gone stale and the Pages check proves nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, type Rollup } from 'vite';
import standaloneFactory from './vite.config.standalone';
import { US_OWNERSHIP_LINE, US_PRODUCTS } from '../packages/health-core/src/us-products';

// "MicroVitamin" alone already appears on Pages (the mailing-list wording and
// the contact address); these markers belong to the product blocks only.
const MARKERS = [US_PRODUCTS.microvitamin_plus.name, US_OWNERSHIP_LINE, US_PRODUCTS.microvitamin_plus.url, 'utm_source=health-tool'];

function found(text: string): string[] {
  return MARKERS.filter((m) => text.includes(m));
}

describe('US-61 AC5: the product blocks never reach the GitHub Pages bundle', () => {
  it('the committed Shopify bundle carries them (the control)', () => {
    const shopify = readFileSync(resolve(__dirname, '../extensions/health-tool-widget/assets/health-plan-v2.js'), 'utf8');
    expect(found(shopify)).toEqual(MARKERS);
  });

  it('the Pages build carries none of them, in code or sourcemaps', async () => {
    const config = standaloneFactory({ command: 'build', mode: 'production' });
    const result = await build({
      ...config,
      configFile: false,
      logLevel: 'silent',
      build: {
        ...config.build,
        write: false,
        emptyOutDir: false,
        rollupOptions: { input: { main: resolve(__dirname, 'standalone/index.html') } },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result as Rollup.RollupOutput]).flatMap((r) => r.output);
    expect(outputs.some((o) => o.type === 'chunk' && o.isEntry)).toBe(true);
    const hits = outputs.flatMap((o) => {
      const text = o.type === 'chunk' ? o.code : typeof o.source === 'string' ? o.source : Buffer.from(o.source).toString('utf8');
      return found(text).map((m) => `${o.fileName}: ${m}`);
    });
    expect(hits).toEqual([]);
    // The module itself is gone, not just its strings.
    const map = outputs.find((o) => o.type === 'asset' && /^assets\/main-.*\.js\.map$/.test(o.fileName));
    expect(map).toBeDefined();
    const sources: string[] = JSON.parse(String((map as Rollup.OutputAsset).source)).sources;
    expect(sources.some((s) => s.endsWith('us-products.ts'))).toBe(false);
    expect(sources.some((s) => s.endsWith('ResultsPanel.tsx'))).toBe(true);
  }, 120_000);
});
