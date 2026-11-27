// The command line of tools/codex-review.mjs, parsed once (US-40 AC19, Codex R1 on PR 2222). Side-effect free.
// Left to right, an option that takes a value consumes the next word, whatever it looks like, exactly once:
// `--message --model --out r.json` is a message "--model" and a real --out. Every reader works from this one parse.

export const VALUE_OPTIONS = ["--codex", "--commit", "--range", "--message", "--model", "--out", "--timeout-min", "--record-file", "--include", "--include-limit-mb", "--subject", "--baseline", "--context"];

/** argv as an ordered list of { name, value? }; a value option at the very end has no value (undefined). */
export function parseArgv(argv) {
  const parsed = [];
  for (let i = 0; i < argv.length; i++) parsed.push(VALUE_OPTIONS.includes(argv[i]) ? { name: argv[i], value: argv[++i] } : { name: argv[i] });
  return parsed;
}

/** Readers over one parse: has(flag); opt(option, default) is the first value; many(option) every value in order ("" for a missing one). */
export const readers = (parsed) => ({
  has: (name) => parsed.some((o) => o.name === name),
  opt: (name, dflt) => { const o = parsed.find((x) => x.name === name); return o ? o.value : dflt; },
  many: (name) => parsed.filter((o) => o.name === name).map((o) => o.value ?? ""),
});
