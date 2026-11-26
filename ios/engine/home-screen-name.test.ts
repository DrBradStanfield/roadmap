// US-25 AC29: the name under the app's icon is "Dr Brad". About 11 to 12
// characters fit under a home screen icon before iOS cuts the name short
// ("Health Roadma..."), and Apple wants it a recognisable short form of the
// App Store name, "Health Roadmap by Dr Brad" (Brad 2026-11-23, ios/architecture.md D17).
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
// The four permission prompts open "This app …", not the display name (Brad 2026-11-23): the
// rest of each sentence is unchanged, so these pin the words the user reads in each prompt.
const permissionPrompts: Record<string, string> = {
  NSCameraUsageDescription:
    "This app uses the camera to scan a paper lab report. With your agreement, the pages are sent to Dr Brad's server and an AI service to be read.",
  NSHealthShareUsageDescription:
    'This app reads your sex, month and year of birth, weight, height, waist and blood pressure from Apple Health, so your record and your plan stay up to date without typing. It never keeps your day of birth. Those go only into your record, on this iPhone or in the Dropbox or Google Drive you connect. It also reads your resting heart rate, sleep, VO2 max and steps, which it shows you and keeps only on this iPhone, never in your record.',
  NSHealthUpdateUsageDescription:
    'This app saves the weight, waist and blood pressure you type into the app to Apple Health.',
  NSHealthClinicalHealthRecordsShareUsageDescription:
    "This app reads the lab results your healthcare provider sent to Health, so they appear in your plan. They are kept in your record, on this iPhone or in the Dropbox or Google Drive you connect. If you use the chat, your question is sent with your record's values and their recent history.",
};

describe('US-25 AC29: directions and the notification title use the home screen name', () => {
  const name = displayNames[0];

  it.each(Object.entries(named))('%s names the app by its display name', (_, line) => {
    expect(line).toContain(name);
    expect(line).not.toContain('Health Roadmap');
  });

  it('the notification title is the display name itself', () => {
    expect(named['the notification title (ReminderScheduler)']).toContain(`content.title = "${name}"`);
  });

});

describe('US-25 AC29: the permission prompts open "This app"', () => {
  it.each(Object.entries(permissionPrompts))('%s reads word for word in Debug and Release', (key, expected) => {
    const strings = [...pbxproj.matchAll(new RegExp(`INFOPLIST_KEY_${key} = "([^"]*)";`, 'g'))].map((m) => m[1]);
    expect(strings).toEqual([expected, expected]);
  });
});

// A record written by a newer version says "this app", not an app name (Brad 2026-11-23).
describe('US-25 AC29: the too-new-record message says "this app"', () => {
  it.each([
    ['the Sync screen (SyncProblem)', lineWith(swift('Sync/SyncProblem.swift'), 'case .tooNew:')],
    ['the engine refusal (my-data TOO_NEW_RECORD)', lineWith(readFileSync(join(__dirname, 'my-data.ts'), 'utf8'), 'export const TOO_NEW_RECORD')],
  ])('%s', (_, line) => {
    expect(line).toContain('A newer version of this app wrote this record.');
    expect(line).not.toContain('Health Roadmap');
  });
});
