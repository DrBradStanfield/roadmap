/**
 * Shared helpers for API route handlers.
 * Extracted from api.measurements, api.reminders, api.user-data to eliminate duplication.
 */

/**
 * Extract and validate the Shopify customer ID from the app proxy request.
 * Returns null if missing or non-numeric (defense-in-depth against malformed IDs).
 */
export function getCustomerId(request: Request): string | null {
  const url = new URL(request.url);
  const id = url.searchParams.get('logged_in_customer_id');
  return id && /^\d+$/.test(id) ? id : null;
}

/**
 * Look up customer email and name from Shopify Admin API.
 */
export async function getCustomerInfo(
  admin: any,
  customerId: string,
): Promise<{ email: string; firstName: string | null; lastName: string | null } | null> {
  try {
    const response = await admin.graphql(`
      query getCustomer($id: ID!) {
        customer(id: $id) {
          email
          firstName
          lastName
        }
      }
    `, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const result = await response.json();
    const customer = result?.data?.customer;
    if (!customer?.email) return null;
    return {
      email: customer.email,
      firstName: customer.firstName || null,
      lastName: customer.lastName || null,
    };
  } catch (error) {
    console.error('Error looking up customer info:', error);
    return null;
  }
}

/** UUID format: 8-4-4-4-12 hex chars */
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/**
 * Validate that a string looks like a UUID (for unsubscribe tokens, etc.).
 */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}
