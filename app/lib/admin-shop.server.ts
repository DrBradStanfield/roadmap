import { authenticate } from '../shopify.server';
import { refuseAppProxyRequest } from './local-first-route.server';

/**
 * The ONE admin authenticator (US-09 AC24): every admin loader and action
 * calls this, never `authenticate.admin` directly (a test greps for it). It
 * refuses an app-proxy request first, since `authenticate.admin`'s bounce page
 * copies the query, `signature` included, into its Location. Each route needs
 * it itself: react-router runs loaders in parallel, a child's redirect beats
 * the parent's 404, and a POST runs only the child's action.
 */
export async function authenticateAdmin(request: Request) {
  refuseAppProxyRequest(request);
  return authenticate.admin(request);
}

/**
 * The gate for admin pages that DO something irreversible on request — send
 * real reminder emails, rewrite trending, fire a digest.
 *
 * `authenticate.admin` proves a merchant, not THIS merchant: the app is
 * AppStore-distributed (shopify.server.ts), so any shop that installs it has
 * an admin who passes. ADMIN_SHOP_DOMAIN names the one shop allowed to press
 * the button. Unset means allow — the check only ever narrows, so nothing
 * breaks before the variable is set.
 */
export async function authenticateOwnerAdmin(request: Request): Promise<void> {
  const { session } = await authenticateAdmin(request);
  const owner = process.env.ADMIN_SHOP_DOMAIN;
  if (owner && session?.shop !== owner) {
    throw new Response('Forbidden', { status: 403 });
  }
}
