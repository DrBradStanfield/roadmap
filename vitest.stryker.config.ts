import { defineConfig } from 'vitest/config';

// Test scope for the weekly clinical mutation run (stryker.clinical.config.json).
// zod.test.ts shells out to git, which does not exist in Stryker's sandbox copy.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    include: ['packages/health-core/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/health-core/src/zod.test.ts'],
  },
});
