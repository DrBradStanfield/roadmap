// Test fixture for release-engine.test.ts, loaded with `node --import`: logs every child
// process this Node process starts, as "<function> <file or command>" (plus " TZ=<zone>" when its env sets one), to $SPAWN_PROBE_LOG. esbuild
// spawns its binary lazily inside build(), and checkParity's tsx children inherit
// NODE_OPTIONS, so a refusal that logs neither never paid for a build.
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[name];
  cp[name] = function (file, ...rest) {
    // The child's TZ, when the call sets an env: check-parity.test.ts checks each zone's own.
    const options = rest.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg));
    const tz = options?.env?.TZ ? ` TZ=${options.env.TZ}` : '';
    appendFileSync(process.env.SPAWN_PROBE_LOG, `${name} ${file}${tz}\n`);
    return real.call(this, file, ...rest);
  };
}
// ESM `import { execFileSync } from 'node:child_process'` sees the wrappers too.
syncBuiltinESMExports();
