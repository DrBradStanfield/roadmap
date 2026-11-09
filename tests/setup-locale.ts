/**
 * Every test starts in a fixed, non-US language (2026-11-06). jsdom reports
 * `en-US`, and `detectUnitSystem` (US-05) rightly picks US units for en-US in a
 * US time zone, so on a machine or CI runner in a US zone 149 widget tests that
 * expect SI units failed, while UTC and Auckland passed. A test of US units
 * passes its locale and zone to `detectUnitSystem`, or stubs `navigator`, itself.
 */
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'language', { value: 'en-GB', configurable: true });
  Object.defineProperty(navigator, 'languages', { value: ['en-GB'], configurable: true });
}
