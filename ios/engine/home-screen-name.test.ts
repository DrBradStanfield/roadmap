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

// Option (a), Brad 2026-11-23: wherever iOS shows the app's name, the app's own words use the
// same one. Settings lists the app, its notifications and its Health access under the display
// name, so a direction naming any other name points at a row that is not there.
const swift = (path: string) => readFileSync(join(__dirname, '../HealthRoadmap', path), 'utf8');
const lineWith = (source: string, marker: string) => {
  const line = source.split('\n').find((l) => l.includes(marker));
  if (!line) throw new Error(`no line with ${marker}`);
  return line;
};
const liveCards = swift('AppleHealthMetrics/LiveCards.swift');
const named = {
  'the Health settings path (LiveCards healthPath)': lineWith(liveCards, 'Data Access & Devices ›'),
  'the Health access line (LiveCards access)': lineWith(liveCards, 'static var access'),
  'the delete-it-yourself steps (EraseText)': lineWith(swift('MyData/EraseText.swift'), 'healthDeleteSteps ='),
  'the notifications direction (RemindersSection)': lineWith(swift('Reminders/RemindersSection.swift'), 'Allow notifications for'),
  'the notification title (ReminderScheduler)': lineWith(swift('Reminders/ReminderScheduler.swift'), 'content.title ='),
};
const permissionKeys = [
  'NSCameraUsageDescription',
  'NSHealthShareUsageDescription',
  'NSHealthUpdateUsageDescription',
  'NSHealthClinicalHealthRecordsShareUsageDescription',
];

describe('US-25 AC29: directions, the notification title and the permission prompts use the home screen name', () => {
  const name = displayNames[0];

  it.each(Object.entries(named))('%s names the app by its display name', (_, line) => {
    expect(line).toContain(name);
    expect(line).not.toContain('Health Roadmap');
  });

  it('the notification title is the display name itself', () => {
    expect(named['the notification title (ReminderScheduler)']).toContain(`content.title = "${name}"`);
  });

  it.each(permissionKeys)('%s starts with the display name in Debug and Release', (key) => {
    const strings = [...pbxproj.matchAll(new RegExp(`INFOPLIST_KEY_${key} = "([^"]*)";`, 'g'))].map((m) => m[1]);
    expect(strings).toHaveLength(2);
    for (const text of strings) {
      expect(text.startsWith(`${name} `)).toBe(true);
      expect(text).not.toContain('Health Roadmap');
    }
  });
});
