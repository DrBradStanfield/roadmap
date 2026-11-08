/**
 * The local vitest worker cap (US-71 AC2, AC5), shared by test:all and both vitest configs.
 * No shebang: Vite bundles this file into the configs, and a `#!` mid-bundle is a syntax error.
 */
import os from 'node:os';

export const workerCap = (env = process.env, cpus = os.cpus().length) =>
  Number(env.TEST_ALL_MAX_WORKERS) > 0 ? String(Number(env.TEST_ALL_MAX_WORKERS)) : String(Math.max(2, Math.floor(cpus / 4)));

export const inCI = (env = process.env) => !!env.CI && env.CI !== 'false' && env.CI !== '0';
