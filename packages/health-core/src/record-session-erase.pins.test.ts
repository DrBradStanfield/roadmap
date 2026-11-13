/**
 * The erase split (record-session-erase.ts) gave the session's erase fields up
 * to a free function: they lost `private` and are marked `@internal`. These
 * pins keep that seam from becoming API, and keep the erase names importable
 * from './record-session', the path the web store and the iPhone engine use
 * (US-09 AC23, US-11 AC6). `mode` stays private: the erase reads its name
 * through `saveMode` and changes it only through `dispatch`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as session from './record-session';
import type { EraseResult, EraseSteps } from './record-session';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
const DIRS = ['widget-src', 'app', 'tools', 'ios/engine', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const OWN = /^packages\/health-core\/src\/record-session[^/]*\.ts$/;
/** Names no other code uses: a read off any receiver fails. */
const DISTINCT = ['revisionSeen', 'saveWarning', 'clearedFor', 'tryClear', 'replaceUnreadable', 'saveMode',
  // The mirror split (record-session-mirror.ts) gave these up the same way.
  'deviceCopySeen', 'mirrorOurs', 'coveredCopy'];
/** Names other code uses on its own objects (React refs' `current`, a store's `host`, a reducer's `dispatch`, a
 *  caller's own open() option `cloudUnreachable`): only a session receiver fails, one named `session` or
 *  `sessions` (`mySession`, `this.session`, `getSession()`) or typed `RecordSession`. */
const GENERIC = ['current', 'host', 'sync', 'ctx', 'dispatch', 'cloudUnreachable'];
const INTERNAL = [...DISTINCT, ...GENERIC];
const SESSION = /sessions?$/i;
/** Array methods whose callback is handed each element: a destructured parameter there reads off a session. */
const ITERATE = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'flatMap', 'reduce']);

/** Lines that read an @internal name, found in the syntax tree, so comments and strings never count:
 *  `.x` (across lines too), `['x']`, a type (`typeof session.x`, `RecordSession['x']`), and a destructuring
 *  (`const { x } = ...` or `{ ['x']: y }`, typed, defaulted, nested, a parameter, a for-of, an assignment). A
 *  DISTINCT name fails off any receiver; a GENERIC one only off a session, seen through parentheses, casts, `!`,
 *  `await` and either side of `??` or `||`. `clean` is false when the file did not parse: the tree is then partial.
 *  Out of scope (no type checker runs here, so the receiver is known only by its name or annotation):
 *  - a GENERIC read off a session under another name, `const s = session; s.current`, `store.host`, or `this` in
 *    a function typed `function (this: RecordSession) { this.host }`;
 *  - a GENERIC name destructured from a session's sub-object, element or derived list,
 *    `const { a: { current } } = session`, `const [{ current }] = sessions`, `= session[0]`,
 *    `of Object.values(sessions)`, or in a callback not handed to an array method on the sessions;
 *  - a key that is not written as a literal, `s[key]` or `{ [key]: v }`, and reads through `Reflect.get`,
 *    `Object.entries` or a spread;
 *  - JavaScript source outside the DIRS walk. */
function internalReads(code: string, fileName = 'probe.ts'): { lines: number[]; clean: boolean } {
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  // createSourceFile never throws: it recovers into a partial tree and records why here.
  const clean = ((file as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []).length === 0;
  const lines: number[] = [];
  const hit = (node: ts.Node) => lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e)
      || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e) ? unwrap(e.expression) : e;
  /** The name a receiver goes by: `session`, `this.session`'s `session`, `getSession()`'s `getSession`. */
  const nameOf = (e: ts.Expression | undefined): string | undefined => {
    if (!e) return undefined;
    const u = unwrap(e);
    if (ts.isIdentifier(u)) return u.text;
    if (ts.isPropertyAccessExpression(u)) return u.name.text;
    if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) return u.argumentExpression.text;
    if (ts.isCallExpression(u)) return nameOf(u.expression);
    return undefined;
  };
  const isSession = (e: ts.Expression | undefined, type?: ts.TypeNode): boolean => {
    const u = e && unwrap(e);
    if (u && ts.isBinaryExpression(u) && (u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || u.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return isSession(u.left) || isSession(u.right);
    return SESSION.test(nameOf(e) ?? '') || (type !== undefined && /\bRecordSession\b/.test(type.getText(file)));
  };
  /** `typeof this.session.x`'s receiver: the last name left of the dot. */
  const entityName = (n: ts.EntityName): string => ts.isIdentifier(n) ? n.text : n.right.text;
  const flags = (key: string | undefined, session: boolean) =>
    key !== undefined && (DISTINCT.includes(key) || (session && GENERIC.includes(key)));
  const keyOf = (n: ts.PropertyName | ts.BindingName | undefined): string | undefined => {
    if (n && ts.isComputedPropertyName(n)) return ts.isStringLiteralLike(n.expression) ? n.expression.text : undefined;
    return n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) ? n.text : undefined;
  };
  /** Is a binding pattern's source a session? Its initializer or annotation, the for-of's iterable, or the receiver
   *  of the array method a callback parameter is handed to (`sessions.map(({ current }) => ...)`; a session's own
   *  method, `session.edit(({ host }) => ...)`, hands its callback something else). */
  const patternIsSession = (p: ts.ObjectBindingPattern): boolean => {
    const owner = p.parent;
    if (ts.isVariableDeclaration(owner)) {
      const forOf = owner.parent.parent;
      return isSession(owner.initializer, owner.type)
        || (ts.isForOfStatement(forOf) && forOf.initializer === owner.parent && isSession(forOf.expression));
    }
    if (ts.isParameter(owner)) {
      if (isSession(owner.initializer, owner.type)) return true;
      const call = owner.parent.parent;
      const method = ts.isCallExpression(call) ? unwrap(call.expression) : undefined;
      return method !== undefined && ts.isPropertyAccessExpression(method) && ITERATE.has(method.name.text)
        && isSession(method.expression);
    }
    return false; // nested: off a sub-object
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (flags(node.name.text, isSession(node.expression))) hit(node.name);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      if (flags(node.argumentExpression.text, isSession(node.expression))) hit(node.argumentExpression);
    } else if (ts.isQualifiedName(node)) {
      if (flags(node.right.text, SESSION.test(entityName(node.left)))) hit(node.right);
    } else if (ts.isIndexedAccessTypeNode(node) && ts.isLiteralTypeNode(node.indexType)
      && ts.isStringLiteral(node.indexType.literal)) {
      const session = SESSION.test(node.objectType.getText(file)) || isSession(undefined, node.objectType);
      if (flags(node.indexType.literal.text, session)) hit(node.indexType);
    } else if (ts.isObjectBindingPattern(node)) {
      const session = patternIsSession(node);
      for (const el of node.elements) if (flags(keyOf(el.propertyName ?? el.name), session)) hit(el);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(unwrap(node.left))) {
      const session = isSession(node.right);
      for (const p of (unwrap(node.left) as ts.ObjectLiteralExpression).properties) {
        if ((ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && flags(keyOf(p.name), session)) hit(p);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { lines, clean };
}

function* sources(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* sources(path);
    else if (SOURCE.test(e.name)) yield path;
  }
}

describe('record-session erase split', () => {
  it('no file outside record-session*.ts reads an @internal field off a session', () => {
    const found: string[] = [];
    const unparsed: string[] = [];
    let scanned = 0;
    let parsed = 0;
    for (const dir of DIRS) {
      for (const path of sources(join(REPO, dir))) {
        const rel = relative(REPO, path);
        if (OWN.test(rel)) continue;
        scanned++;
        const { lines, clean } = internalReads(readFileSync(path, 'utf8'), path);
        if (clean) parsed++; else unparsed.push(rel);
        for (const line of lines) found.push(`${rel}:${line}`);
      }
    }
    expect(unparsed).toEqual([]); // a file that fails to parse is scanned only in part
    expect(parsed).toBe(scanned);
    expect(found).toEqual([]);
    expect(scanned).toBeGreaterThan(1000); // the walk reached the clients (about 1200 files), not an empty tree
  });

  it('the read check reports a file it cannot parse, whose tree is partial', () => {
    expect(internalReads('const { saveMode } = s;').clean).toBe(true);
    expect(internalReads('const { saveMode = s;\nsession.current;').clean).toBe(false);
  });

  const caught = (code: string) => internalReads(code).lines.length > 0;
  it.each(['store.saveMode', "x['tryClear']", 'this.session.current', "mySession?.['host']",
    'const { saveMode } = store;', 'const {\n  revisionSeen,\n} = s;', 'const { clearedFor: c } = await open();',
    'const { current } = this.session;', 'const { sync, ctx } = session;', 'session.cloudUnreachable',
    'const { cloudUnreachable } = await this.session;',
    // H99: the forms the regex missed.
    '(session as unknown as Inside).dispatch(action);', '(this.session as X).current;', 'const { current } = (session as X);',
    'const { saveMode }: RecordSession = s;', 'sessions.map(({ saveMode }) => saveMode);', 'for (const { current } of sessions) {}',
    'const { a: { b }, saveMode } = s;', 'const { saveMode = {} } = s;', 'session\n  .current;',
    // H99 review: forms the regex caught that the first syntax-tree scan missed.
    "const { ['saveMode']: m } = s;", "const { ['current']: c } = session;", 'type T = typeof session.saveMode;',
    'type C = typeof this.session.current;', "type T = RecordSession['saveMode'];", "type H = RecordSession['host'];",
    'const { current } = session ?? fallback;', 'const { host } = this.session || x;',
    'sessions.forEach(({ current }) => current);',
  ])('the read check catches %j', (code) => { expect(caught(code)).toBe(true); });

  it.each(['ref.current', 's.dispatch(action)', 'const { current } = ref;', 'const { dispatch } = useStore();',
    'const { host } = sessionStore;',
    'open(host, { cloudUnreachable });', // an object literal, not a read: the regex left it alone too
    // H99: a caller's own open() options, and the names in comments and strings.
    'const { cloudUnreachable } = opts;', 'opts.cloudUnreachable', '// store.saveMode and session.current', "const s = 'store.saveMode';",
    '/* const { revisionSeen } = s; */', 'const t = `this.session.current`;',
    // H99 review: a session method's callback gets the file, not a session (ios/engine/cloud.ts:192).
    'session.edit(({ host }) => host);', 'const { current } = ref ?? fallback;', 'type R = typeof ref.current;',
    "type H = Store['host'];",
  ])('the read check leaves %j alone', (code) => { expect(caught(code)).toBe(false); });

  // No build emits declarations: package.json exports "./*" as "./src/*.ts", so
  // every importer compiles the source and can see these members. This checks
  // only that each carries its @internal tag; the read check above is the guard.
  it('every member the erase reads carries @internal, and mode stays private', () => {
    const file = join(REPO, 'packages/health-core/src/record-session.ts');
    const { outputText } = ts.transpileDeclaration(readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { stripInternal: true },
    });
    const cls = outputText.slice(outputText.indexOf('export declare class RecordSession'));
    for (const name of INTERNAL) expect(cls, name).not.toMatch(new RegExp(`^ {4}(?:readonly |get )?${name}\\b`, 'm'));
    expect(cls).toMatch(/^ {4}private mode;/m);
    for (const name of ['erase', 'deleteAllData', 'clearOffFileData', 'flush']) expect(cls, name).toMatch(new RegExp(`^ {4}${name}\\(`, 'm'));
  });

  it('the erase names still come from ./record-session (ios/engine/cloud.ts, roadmap-store.ts)', () => {
    expect(session.ERASE_UNREACHABLE).toMatch(/nothing was deleted/);
    expect(session.ERASE_BUSY).toBe('Already deleting your data.');
    expect(session.ERASE_STALE_TAB).toMatch(/out of date/);
    expect(typeof session.RecordSession.prototype.deleteAllData).toBe('function');
    expect(session.RecordSession.prototype.deleteAllData.length).toBe(0); // steps defaults to {}, as before the split
    expect(typeof session.RecordSession.prototype.erase).toBe('function');
    const result: EraseResult = { success: false, error: session.ERASE_BUSY };
    const steps: EraseSteps = { teardown: async () => {} };
    expect([result.success, typeof steps.teardown]).toEqual([false, 'function']);
  });

  it('the importers name the path these pins check', () => {
    const imports = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
    expect(imports('ios/engine/cloud.ts')).toMatch(/import \{[^}]*\bERASE_UNREACHABLE\b[^}]*\} from '\.\.\/\.\.\/packages\/health-core\/src\/record-session';/);
    const store = imports('widget-src/src/storage/roadmap-store.ts');
    expect(store).toMatch(/type EraseResult, type EraseSteps \} from '@roadmap\/health-core\/record-session';/);
    expect(store).toMatch(/export \{ ERASE_UNREACHABLE \} from '@roadmap\/health-core\/record-session';/);
  });
});
