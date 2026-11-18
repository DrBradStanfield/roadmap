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
interface FieldsRoot { source?: { input: { file?: string } }; walkRules(each: (rule: { selectors: string[] }) => void): void }
export const scopeSharedFields = {
  postcssPlugin: 'scope-shared-fields',
  Once(root: FieldsRoot) {
    if (!root.source?.input.file?.endsWith('/src/components/fields.css')) return;
    root.walkRules((rule) => {
      rule.selectors = rule.selectors.map((s) => (s === ':root' ? '.hr-widget'
        : s.startsWith('.health-tool ') ? `.hr-widget${s.slice('.health-tool'.length)}` : `:where(.hr-widget) ${s}`));
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
