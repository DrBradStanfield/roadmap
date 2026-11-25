import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { execSync } from 'child_process';

let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout */
}
const release = `health-tool-widget@${gitHash}`;

/** The full app's field styles (src/components/fields.css), scoped to the
 *  widget's root on the way into this bundle, so they never reach the store's
 *  page outside the block (US-74). Each rule keeps the app's specificity: the
 *  app's `.health-tool` root becomes `.hr-widget`, an unscoped rule gains a
 *  `:where(.hr-widget)` that adds none, and `:root` (the controls' geometry)
 *  becomes `.hr-widget`. */
/** The part of a PostCSS root this plugin reads (PostCSS comes with Vite; no import, so no new dependency). */
interface FieldsRule { selectors: string[]; parent?: { type: string; name?: string } }
interface FieldsRoot { source?: { input: { file?: string } }; walkRules(each: (rule: FieldsRule) => void): void }
/** One selector of fields.css, scoped to the widget's root with the specificity it had. */
export function scopeSelector(s: string): string {
  if (s === ':root') return '.hr-widget';
  if (s.startsWith('.health-tool ')) return `.hr-widget${s.slice('.health-tool'.length)}`;
  // Only the app's root as a whole first compound can be swapped; anything else would scope wrongly.
  if (s.includes('.health-tool')) throw new Error(`fields.css: cannot scope "${s}"; start it with ".health-tool " or not at all`);
  return `:where(.hr-widget) ${s}`;
}
export const scopeSharedFields = {
  postcssPlugin: 'scope-shared-fields',
  Once(root: FieldsRoot) {
    if (!root.source?.input.file?.endsWith('/src/components/fields.css')) return;
    root.walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name ?? '')) return; // "from", "50%": not selectors
      rule.selectors = rule.selectors.map(scopeSelector);
    });
  },
};

// Single-topic widgets (US-74 AC8): one IIFE bundle for every theme block that
// names its topic in `data-widget`; a new topic adds a component, not a bundle.
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [scopeSharedFields] } },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__SENTRY_RELEASE__': JSON.stringify(release),
    // A Shopify surface: its usage events (waist_widget_viewed / _saved) go
    // through the app proxy, and trackProductEvent no-ops without this.
    'import.meta.env.VITE_SHOPIFY_SURFACE': JSON.stringify('true'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'standalone/widgets.tsx'),
      name: 'HealthWidgets',
      fileName: () => 'health-widgets.js',
      formats: ['iife'],
    },
    outDir: resolve(__dirname, '../extensions/health-tool-widget/assets'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        assetFileNames: 'health-widgets.[ext]',
      },
    },
    cssCodeSplit: false,
    sourcemap: 'hidden',
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
});
