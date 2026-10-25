// The one door to zod. `jitless` keeps zod from compiling object parsers with
// `new Function` (CLAUDE.md: no eval / new Function, a dependency's included).
// Zod reads it when an object schema is built, so every module that builds a
// schema takes `* as z` from here, never from 'zod' (zod.test.ts holds that).
import { config } from 'zod';

config({ jitless: true });

export * from 'zod';
