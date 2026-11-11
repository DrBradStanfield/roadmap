/**
 * Shared upload PR 3 (US-12, US-52 AC7): the limits and verdicts both clients read with,
 * against the golden pins (__fixtures__/upload-decisions.json, read unedited) and a
 * table of the cases between them. Synthetic names only.
 */
import { describe, expect, it } from 'vitest';
import table from './__fixtures__/upload-decisions.json';
import { IMPORT_LIMITS } from './import-hints';
import { isImportableEntryName } from './lab-extraction';
import { fileVerdict, UPLOAD_LIMITS, zipMemberVerdict, type FileVerdict } from './upload-rules';

const MB = 1024 * 1024;

describe('UPLOAD_LIMITS', () => {
  it('holds each platform\'s limits as the pins name them', () => {
    expect(UPLOAD_LIMITS.web).toMatchObject(table.limits.web);
    expect(UPLOAD_LIMITS.phone).toMatchObject(table.limits.phone);
    expect(UPLOAD_LIMITS.web.photoPx).toBe(table.photoResize.web);
    expect(UPLOAD_LIMITS.phone.photoPx).toBe(table.photoResize.phone);
  });

  it('takes the shared numbers from IMPORT_LIMITS', () => {
    expect(UPLOAD_LIMITS.web.fileBytes).toBe(IMPORT_LIMITS.websiteFileMb * MB);
    expect(UPLOAD_LIMITS.phone.zipBytes).toBe(IMPORT_LIMITS.zipMb * MB);
    expect(UPLOAD_LIMITS.phone.zipMembers).toBe(IMPORT_LIMITS.websiteFiles);
  });
});

describe('fileVerdict against the pins', () => {
  const zipKind = (name: string) => (name.toLowerCase().endsWith('.zip') ? 'zip' : 'file') as const;

  it.each(table.fileSizes.rows)('$name of $bytes bytes: web $web, phone $phone (D8)', ({ name, bytes, web, phone }) => {
    expect(fileVerdict({ name, bytes, kind: zipKind(name), platform: 'web' })).toBe(web === 'read' ? 'keep' : 'tooLarge');
    expect(fileVerdict({ name, bytes, platform: 'phone' })).toBe(phone === 'fits' ? 'keep' : 'tooLarge');
  });

  it.each(table.fileKinds.rows)('$name on the phone: $phone (D15)', ({ name, phone }) => {
    expect(fileVerdict({ name, bytes: 1, platform: 'phone' })).toBe(phone === 'unsupported' ? 'unsupported' : 'keep');
  });
});

describe('zipMemberVerdict against the pins', () => {
  it.each(table.zipMembers.rows)('$path: web $web, phone $phone (D9)', ({ path, web, phone }) => {
    expect(zipMemberVerdict(path, 'web') === 'keep').toBe(web);
    expect(zipMemberVerdict(path, 'phone') === 'keep').toBe(phone);
  });
});

describe('fileVerdict', () => {
  const cases: Array<[string, number, 'file' | 'zip' | undefined, 'web' | 'phone', FileVerdict]> = [
    ['a.pdf', 0, undefined, 'phone', 'keep'],
    ['a.HEIC', 1, undefined, 'phone', 'keep'],
    ['a.docx', 1, undefined, 'phone', 'unsupported'],
    ['noextension', 1, undefined, 'phone', 'unsupported'],
    ['.pdf', 1, undefined, 'phone', 'unsupported'],
    ['folder.pdf/notes', 1, undefined, 'phone', 'unsupported'],
    ['labs.zip/a.pdf', 10 * MB + 1, undefined, 'phone', 'tooLarge'],
    // The size comes before the kind, as both readers check it first.
    ['a.docx', 10 * MB + 1, undefined, 'phone', 'tooLarge'],
    ['a.zip', 20 * MB, undefined, 'phone', 'keep'],
    ['a.zip', 20 * MB, 'file', 'phone', 'tooLarge'],
    ['a', 20 * MB, 'zip', 'phone', 'keep'],
    // The web's readers decide the kind (by name and MIME type): its verdict is size alone.
    ['notes.txt', 1, 'file', 'web', 'keep'],
    ['a.zip', 10 * MB, 'zip', 'web', 'keep'],
    ['a.zip', 10 * MB + 1, 'zip', 'web', 'tooLarge'],
    ['a.pdf', 10 * MB + 1, 'file', 'web', 'tooLarge'],
  ];
  it.each(cases)('%s, %i bytes, kind %s, %s → %s', (name, bytes, kind, platform, verdict) => {
    expect(fileVerdict({ name, bytes, kind, platform })).toBe(verdict);
  });
});

describe('zipMemberVerdict', () => {
  const cases: Array<[string, 'web' | 'phone', FileVerdict]> = [
    ['a.pdf', 'web', 'keep'],
    ['a.txt', 'web', 'unsupported'],
    ['a.heic', 'web', 'unsupported'],
    ['.a.pdf', 'web', 'hidden'],
    ['dir/.git/a.pdf', 'web', 'hidden'],
    ['__MACOSX/a.txt', 'web', 'hidden'],
    ['x/Thumbs.db', 'web', 'hidden'],
    ['a/.DS_Store', 'web', 'hidden'],
    ['a.pdf', 'phone', 'keep'],
    ['A/B.JPG', 'phone', 'keep'],
    ['a.heic', 'phone', 'unsupported'],
    ['a.txt', 'phone', 'unsupported'],
    ['dir/.a.pdf', 'phone', 'hidden'],
    ['x/__MACOSX/a.pdf', 'phone', 'hidden'],
    ['.git/a.pdf', 'phone', 'keep'],
    ['__macosx/a.pdf', 'phone', 'keep'],
  ];
  it.each(cases)('%s on %s → %s', (path, platform, verdict) => {
    expect(zipMemberVerdict(path, platform)).toBe(verdict);
  });

  it('on the web, keeps exactly what isImportableEntryName keeps', () => {
    const paths = ['a.pdf', 'a.PNG', 'b/c.jpeg', 'x.heic', '.x.pdf', 'd/.e/f.pdf', '__MACOSX/a.pdf', 'thumbs.db.png', 'a.ds_store.pdf', 'z', 'z.'];
    for (const path of paths) expect(zipMemberVerdict(path, 'web') === 'keep', path).toBe(isImportableEntryName(path));
  });
});
