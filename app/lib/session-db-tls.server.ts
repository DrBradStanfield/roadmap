// US-09 AC31 (GHSA-m5fr-866c-fc8x): the Shopify session store holds each shop's
// offline Admin API token, so it must reach Postgres over TLS. The store library
// builds its pg pool from the URL's parts and drops the query string, so
// `?sslmode=` in SESSION_DATABASE_URL does nothing; only PGSSLMODE turns TLS on.
// Production refuses to start without it rather than connect in plaintext.
const TLS_MODES = ['require', 'verify-ca', 'verify-full', 'no-verify'];

export function assertSessionDbTls(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== 'production' || TLS_MODES.includes(env.PGSSLMODE ?? '')) return;
  throw new Error(
    `PGSSLMODE must be one of ${TLS_MODES.join(', ')} for the Shopify session store; ` +
      'the store ignores sslmode in SESSION_DATABASE_URL',
  );
}
