import { defineConfig } from 'vite';
import { resolve } from 'path';
import { execSync } from 'child_process';

// Standalone static build for GitHub Pages / self-host (front door B,
// implementation plan §5.4). Same React tree will mount here in Phase 1; for
// Phase 0 it serves the storage-spine self-test page.
//
// base '/roadmap/' targets the GitHub project page
// https://drbradstanfield.github.io/roadmap/. Override with VITE_BASE for a
// custom domain or a different repo path.
let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  /* not a git checkout (e.g. tarball build) */
}

export default defineConfig({
  base: process.env.VITE_BASE ?? '/roadmap/',
  root: resolve(__dirname, 'standalone'),
  define: {
    'import.meta.env.VITE_GIT_HASH': JSON.stringify(gitHash),
  },
  resolve: {
    alias: {
      '@roadmap/health-core': resolve(__dirname, '../packages/health-core/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-pages'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
