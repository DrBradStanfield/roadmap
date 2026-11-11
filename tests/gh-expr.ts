/**
 * A small evaluator for the GitHub Actions expressions our workflow tests pin.
 * It covers what those files use: context paths (with `.*.` for a list),
 * strings, numbers, true/false/null, ! == != && || and parentheses, and the
 * functions contains, startsWith and fromJSON. && and || return an operand,
 * as GitHub's do; == on strings ignores case, as GitHub's does.
 * Anything else throws, so a test never passes on an expression it misread.
 */
type Value = unknown;

const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.(?:\*|[A-Za-z_][\w-]*))*)|(==|!=|&&|\|\||[!(),]))/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`cannot read expression at: ${src.slice(TOKEN.lastIndex)}`);
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return out;
}

const truthy = (v: Value) => !(v === false || v === null || v === undefined || v === '' || v === 0);
const eq = (a: Value, b: Value) =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

function lookup(path: string, ctx: Record<string, Value>): Value {
  let cur: Value = ctx;
  for (const part of path.split('.')) {
    if (part === '*') {
      if (!Array.isArray(cur)) return [];
      continue; // the next part maps over the list
    }
    if (Array.isArray(cur)) cur = cur.map((x) => (x as Record<string, Value>)?.[part]);
    else cur = cur == null ? null : (cur as Record<string, Value>)[part];
  }
  return cur ?? null;
}

const FUNCS: Record<string, (...a: Value[]) => Value> = {
  contains: (hay, needle) =>
    Array.isArray(hay) ? hay.some((x) => eq(x, needle)) : String(hay ?? '').toLowerCase().includes(String(needle).toLowerCase()),
  startsWith: (s, p) => String(s ?? '').toLowerCase().startsWith(String(p).toLowerCase()),
  fromJSON: (s) => JSON.parse(String(s)),
};

export function evalExpr(src: string, ctx: Record<string, Value>): Value {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const take = (want?: string) => {
    const tok = t[i++];
    if (want !== undefined && tok !== want) throw new Error(`expected ${want}, got ${tok} in: ${src}`);
    return tok;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === '||') { take(); const r = and(); v = truthy(v) ? v : r; }
    return v;
  };
  const and = (): Value => {
    let v = cmp();
    while (peek() === '&&') { take(); const r = cmp(); v = truthy(v) ? r : v; }
    return v;
  };
  const cmp = (): Value => {
    let v = unary();
    while (peek() === '==' || peek() === '!=') {
      const op = take();
      const r = unary();
      v = op === '==' ? eq(v, r) : !eq(v, r);
    }
    return v;
  };
  const unary = (): Value => (peek() === '!' ? (take(), !truthy(unary())) : primary());
  const primary = (): Value => {
    const tok = take();
    if (tok === undefined) throw new Error(`unexpected end of: ${src}`);
    if (tok === '(') { const v = or(); take(')'); return v; }
    if (tok.startsWith("'")) return tok.slice(1, -1).replace(/''/g, "'");
    if (/^\d/.test(tok)) return Number(tok);
    if (tok === 'true' || tok === 'false') return tok === 'true';
    if (tok === 'null') return null;
    if (peek() === '(') {
      const fn = FUNCS[tok];
      if (!fn) throw new Error(`unknown function ${tok}`);
      take('(');
      const args: Value[] = [];
      while (peek() !== ')') { args.push(or()); if (peek() === ',') take(); }
      take(')');
      return fn(...args);
    }
    return lookup(tok, ctx);
  };
  const v = or();
  if (i !== t.length) throw new Error(`trailing tokens in: ${src}`);
  return v;
}

/** A YAML string with `${{ }}` parts filled in; a value that is one expression keeps its type. */
export function interpolate(s: string, ctx: Record<string, Value>): Value {
  const whole = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('}}')) return evalExpr(whole[1], ctx);
  return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => String(evalExpr(e, ctx) ?? ''));
}
