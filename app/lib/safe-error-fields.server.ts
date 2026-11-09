/** What a database, auth or other server error may log or report: its code, when a plain identifier
 *  of up to 32 letters, digits or underscores (else `unknown`), and its HTTP status when it has one.
 *  Never its message, details or hint: a Postgres error's details can echo an id or an email (US-15
 *  AC7e). A code of only digits longer than a 5-character SQLSTATE is the shape of a Shopify customer
 *  id, so it is refused too (issue #927). */
export function safeErrorFields(error: unknown): { code: string; status?: number } {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  const plain = typeof code === 'string' && /^\w{1,32}$/.test(code) && !/^\d{6,}$/.test(code);
  return { code: plain ? code : 'unknown', ...(typeof status === 'number' ? { status } : {}) };
}
