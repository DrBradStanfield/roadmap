// Test fixture for release-engine.test.ts, loaded with `node --import`: logs every child
// process this Node process starts, as "<function> <file>", to $SPAWN_PROBE_LOG. esbuild
// spawns its binary lazily inside build(), and checkParity's tsx children inherit
// NODE_OPTIONS, so a refusal that logs neither never paid for a build.
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const real = cp[name];
  cp[name] = function (file, ...rest) {
    appendFileSync(process.env.SPAWN_PROBE_LOG, `${name} ${file}\n`);
    return real.call(this, file, ...rest);
  };
}
// ESM `import { execFileSync } from 'node:child_process'` sees the wrappers too.
syncBuiltinESMExports();
