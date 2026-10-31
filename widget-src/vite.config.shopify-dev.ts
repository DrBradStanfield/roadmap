import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { composePage, EMPTY_SHELL, localiseBradServer, renderAppBlock, stubResponse, themeShell, type ThemeShell } from './shopify-dev/storefront';

// The Shopify-like localhost (`npm run dev:shopify`, port 5174). It runs the
// storefront widget's own entry with VITE_SHOPIFY_SURFACE, so the email box,
// Save as PDF gating, the feedback form and the US-61 product blocks render,
// inside drstanfield.com's live theme CSS and wrapper markup, against a STUBBED
// app proxy. Never `shopify app dev` (it overrides production). Nothing here
// reaches Brad's server: every /apps/health-tool-1 call is answered locally, and
// the absolute Brad-server URLs in widget source (the Google token exchange,
// reminders) are rewritten, in this dev build only, to a stubbed local prefix.
// Sentry is off on every loopback host (src/lib/sentry.ts).
//
// Query: ?skip_email_gate=true (the /pages/start setting), ?country=NZ
// (anything but US hides the product blocks), ?theme=off (no live theme CSS).

const LIVE_PAGE = 'https://drstanfield.com/pages/roadmap';
const BLOCK = resolve(__dirname, '../extensions/health-tool-widget/blocks/app-block.liquid');
const UPLOAD_BUNDLE = resolve(__dirname, '../extensions/health-tool-widget/assets/health-upload.js');

let shell: Promise<ThemeShell> | null = null;
/** Fetched once per server: the live theme changes rarely, and offline still works. */
function liveShell(): Promise<ThemeShell> {
  shell ??= fetch(LIVE_PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (dev:shopify)' } })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((html) => themeShell(html))
    .catch((error: unknown) => {
      console.warn(`[dev:shopify] live theme not loaded (${String(error)}); the page renders without it`);
      shell = null; // try again on the next load
      return EMPTY_SHELL;
    });
  return shell;
}

export function shopifyDev(): Plugin {
  return {
    name: 'shopify-dev',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('/node_modules/') || !/\.[jt]sx?$/.test(id.split('?')[0])) return null;
      const local = localiseBradServer(code);
      return local === code ? null : { code: local, map: null };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const stubbed = stubResponse(req.method ?? 'GET', url.pathname);
        if (stubbed) {
          const { status, body } = stubbed;
          // Paths only: bodies can hold an email or health values.
          console.info(`[dev:shopify] stub ${req.method} ${url.pathname} -> ${status}`);
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
          return;
        }
        if (url.pathname === '/health-upload.js' && existsSync(UPLOAD_BUNDLE)) {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(readFileSync(UPLOAD_BUNDLE));
          return;
        }
        if (url.pathname !== '/' && !url.pathname.startsWith('/pages/')) return next();
        try {
          const block = renderAppBlock(readFileSync(BLOCK, 'utf8'), {
            skipEmailGate: url.searchParams.get('skip_email_gate') === 'true',
            country: url.searchParams.get('country') ?? 'US',
            uploadUrl: '/health-upload.js',
            entry: '/standalone/app.tsx',
          });
          const theme = url.searchParams.get('theme') === 'off' ? EMPTY_SHELL : await liveShell();
          const html = await server.transformIndexHtml(req.url ?? '/', composePage(block, theme));
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [shopifyDev(), react()],
  server: { port: 5174, strictPort: true },
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
    'import.meta.env.VITE_GIT_HASH': JSON.stringify('dev'),
    // As the storefront build (vite.config.shopify-prod.ts): local-first, Shopify surface.
    'import.meta.env.VITE_LOCAL_FIRST': JSON.stringify('true'),
    'import.meta.env.VITE_SHOPIFY_SURFACE': JSON.stringify('true'),
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
});
