/**
 * US-61 AC5: the shopper's market country, from the tool root's `data-country`,
 * which the app block fills with Shopify's `localization.country.iso_code` (the
 * same signal /pages/my-supplements reads; `?country=US` forces it). Only a
 * two-letter code counts; anything else is no country. Never persisted: it is a
 * property of the page, not of the user. Same resolve/set/get pattern as
 * assistant-config.ts.
 */
let marketCountry: string | null = null;

export function resolveMarketCountry(root: HTMLElement | null): string | null {
  const value = root?.dataset.country?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) ? value : null;
}

export function setMarketCountry(country: string | null): void {
  marketCountry = country;
}

export function getMarketCountry(): string | null {
  return marketCountry;
}
