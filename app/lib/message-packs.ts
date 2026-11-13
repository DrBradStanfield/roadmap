/**
 * Message pack configuration — single source of truth for pack sizes and variant IDs.
 * Used by webhooks.orders-paid.ts (credit amounts).
 */

const PACK_CONFIG = [
  { envKey: 'MESSAGE_PACK_25_VARIANT_ID', amount: 25 },
  { envKey: 'MESSAGE_PACK_60_VARIANT_ID', amount: 60 },
  { envKey: 'MESSAGE_PACK_150_VARIANT_ID', amount: 150 },
] as const;

/** Variant ID → credit amount map (for webhook handler). */
export const VARIANT_CREDIT_MAP: Record<string, number> = {};
for (const pack of PACK_CONFIG) {
  const variantId = process.env[pack.envKey];
  if (variantId) VARIANT_CREDIT_MAP[variantId] = pack.amount;
}

// Warn at startup if no packs are configured (env vars missing)
if (Object.keys(VARIANT_CREDIT_MAP).length === 0 && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: No MESSAGE_PACK_*_VARIANT_ID env vars configured — message packs disabled');
}
