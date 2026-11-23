// US-25 AC29: the name under the app's icon is "Dr Brad". About 11 to 12
// characters fit under a home screen icon before iOS cuts the name short
// ("Health Roadma..."), and Apple wants it a recognisable short form of the
// App Store name, "Health by Dr Brad" (Brad 2026-11-23, ios/architecture.md D17).
// Read from the project source, as lab-consent-wording.test.ts reads Swift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pbxproj = readFileSync(join(__dirname, '../HealthRoadmap.xcodeproj/project.pbxproj'), 'utf8');
const infoPlist = readFileSync(join(__dirname, '../HealthRoadmap-Info.plist'), 'utf8');
const displayNames = [...pbxproj.matchAll(/INFOPLIST_KEY_CFBundleDisplayName = "?([^";]*)"?;/g)].map((m) => m[1]);

describe('US-25 AC29: the home screen name', () => {
  it('is set in both app build configurations, Debug and Release', () => {
    expect(displayNames).toHaveLength(2);
  });

  it('is "Dr Brad" in every configuration', () => {
    for (const name of displayNames) expect(name).toBe('Dr Brad');
  });

  it('fits under the icon: 12 characters or fewer', () => {
    for (const name of displayNames) expect(name.length).toBeLessThanOrEqual(12);
  });

  it('is not overridden by the Info.plist', () => {
    expect(infoPlist).not.toContain('CFBundleDisplayName');
  });

  it('leaves the bundle id alone', () => {
    expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.drstanfield.healthroadmap;');
  });
});
