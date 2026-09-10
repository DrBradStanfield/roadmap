import { authenticate } from '../shopify.server';

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
  const { session } = await authenticate.admin(request);
  const owner = process.env.ADMIN_SHOP_DOMAIN;
  if (owner && session?.shop !== owner) {
    throw new Response('Forbidden', { status: 403 });
  }
}
