/**
 * Drive's query language quotes a name with `'` and escapes with `\`, so a
 * backslash in a name must be escaped as well as a quote. Otherwise a name
 * ending in `\` swallows its closing quote, and `\'` closes the string early.
 * Read the name back out of the query Drive receives: it must be exactly the
 * name asked for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveFindFileId, driveFindFolder } from './drive-rest';

afterEach(() => vi.unstubAllGlobals());

/** The query each request sent. */
function captureQueries(): string[] {
  const queries: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    queries.push(new URL(String(input)).searchParams.get('q') ?? '');
    return new Response(JSON.stringify({ files: [] }), { status: 200 });
  }));
  return queries;
}

/** Every `name='…'` literal in `q`, read the way Drive reads it (`\x` is x). */
function nameLiterals(q: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = q.indexOf("name='", i)) !== -1) {
    i += "name='".length;
    let s = '';
    for (; i < q.length && q[i] !== "'"; i++) s += q[i] === '\\' ? q[++i] : q[i];
    if (i >= q.length) throw new Error(`unterminated literal in: ${q}`);
    out.push(s);
    i++;
  }
  return out;
}

const NAMES = ["O'Brien.pdf", 'scan\\', "a\\' or name contains '", 'C:\\labs\\2026.pdf'];

describe('Drive name queries escape backslash and quote', () => {
  it.each(NAMES)('driveFindFileId asks for exactly %j', async (name) => {
    const queries = captureQueries();
    await driveFindFileId('token', name, 'parent-1');
    expect(nameLiterals(queries[0])).toEqual([name]);
    expect(queries[0]).toMatch(/ and trashed=false and 'parent-1' in parents$/);
  });

  it('driveFindFolder asks for exactly each name', async () => {
    const queries = captureQueries();
    await driveFindFolder('token', NAMES, 'parent-1');
    expect(nameLiterals(queries[0])).toEqual(NAMES);
  });
});
