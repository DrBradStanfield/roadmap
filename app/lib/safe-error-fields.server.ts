/** What a database, auth or other server error may log or report: its class name and its code, each
 *  when a plain identifier (name up to 40 letters, digits or underscores; code up to 32; else the name
 *  is left out and the code is `unknown`), and its HTTP status when it has one. Never its message,
 *  details or hint: a Postgres error's details can echo an id or an email (US-15 AC7e). A run of only
 *  digits longer than a 5-character SQLSTATE is the shape of a Shopify customer id, so it is refused
 *  too (issue #927). */
export function safeErrorFields(error: unknown): { name?: string; code: string; status?: number } {
  const { name, code, status } = (error ?? {}) as { name?: unknown; code?: unknown; status?: unknown };
  const plain = (v: unknown, shape: RegExp): v is string => typeof v === 'string' && shape.test(v) && !/^\d{6,}$/.test(v);
  return { ...(plain(name, /^\w{1,40}$/) ? { name } : {}), code: plain(code, /^\w{1,32}$/) ? code : 'unknown', ...(typeof status === 'number' ? { status } : {}) };
}
