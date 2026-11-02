import { describe, expect, it } from 'vitest';
import { detectUnitSystem } from './units';

// US-05 AC5: labs in the US territories print US (conventional) units, as on
// the mainland. The default came out SI there: a territory's own time zone was
// not on the US list, so en-US read as a US-English browser abroad, and a
// territory's own region code (es-PR, en-GU) was not on the conventional list.
const TERRITORIES = [
  ['Puerto Rico', 'PR', 'America/Puerto_Rico'],
  ['US Virgin Islands', 'VI', 'America/St_Thomas'],
  ['Guam', 'GU', 'Pacific/Guam'],
  ['Northern Mariana Islands', 'MP', 'Pacific/Saipan'],
  ['American Samoa', 'AS', 'Pacific/Pago_Pago'],
] as const;

describe('US-05 AC5 — the default unit system in the US territories', () => {
  it.each(TERRITORIES)('%s: en-US in its own time zone is conventional', (_name, _region, zone) => {
    expect(detectUnitSystem('en-US', zone)).toBe('conventional');
  });

  it.each(TERRITORIES)('%s: its own region code is conventional', (_name, region, zone) => {
    expect(detectUnitSystem(`en-${region}`, zone)).toBe('conventional');
    expect(detectUnitSystem(`es-${region}`)).toBe('conventional');
  });

  it('a neighbouring island outside the US stays SI, by region and by en-US with its zone', () => {
    expect(detectUnitSystem('en-AG', 'America/Antigua')).toBe('si');
    expect(detectUnitSystem('en-US', 'America/Antigua')).toBe('si');
    expect(detectUnitSystem('en-US', 'America/Tortola')).toBe('si');
    expect(detectUnitSystem('en-US', 'Pacific/Apia')).toBe('si');
  });
});
