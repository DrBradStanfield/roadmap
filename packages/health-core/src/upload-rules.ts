/**
 * The upload's limits and its verdict on each file (US-12, US-52 AC7): one home for
 * both clients. The web imports these; the iPhone app asks them through the optional
 * engine door `uploadVerdictsJson` (ios/engine/entry.ts), keeping its Swift copy for
 * an older engine. Today's values and rules per platform, where the two still differ
 * (survey D8, D9, D10: later decisions; pinned in __fixtures__/upload-decisions.json).
 * The shared numbers come from IMPORT_LIMITS, which the connector's hints name.
 */
import { IMPORT_LIMITS } from './import-hints';
import { isImportableEntryName } from './lab-extraction';

const MB = 1024 * 1024;

export type UploadPlatform = 'web' | 'phone';

export const UPLOAD_LIMITS = {
  web: {
    fileBytes: IMPORT_LIMITS.websiteFileMb * MB,
    /** D8: the web reads a ZIP under the file cap. */
    zipBytes: IMPORT_LIMITS.websiteFileMb * MB,
    filesPerPick: IMPORT_LIMITS.websiteFiles,
    zipMembers: IMPORT_LIMITS.websiteFiles,
    pdfPages: IMPORT_LIMITS.websitePdfPages,
    textPageChars: IMPORT_LIMITS.websiteTextPageChars,
    /** From this many files, one server batch instead of a file at a time. */
    batchFrom: 20,
    /** D10: a picked photo's long side as sent. */
    photoPx: 1200,
  },
  phone: {
    fileBytes: IMPORT_LIMITS.websiteFileMb * MB,
    /** D8: the phone reads a ZIP up to the connector's ZIP cap. */
    zipBytes: IMPORT_LIMITS.zipMb * MB,
    filesPerPick: IMPORT_LIMITS.websiteFiles,
    zipMembers: IMPORT_LIMITS.websiteFiles,
    pdfPages: IMPORT_LIMITS.websitePdfPages,
    textPageChars: IMPORT_LIMITS.websiteTextPageChars,
    /** The most a ZIP's members, or a folder's reports, may hold in all. */
    folderBytes: 200 * MB,
    /** D10: a picture or a scanned page's long side as sent. */
    photoPx: 2000,
  },
} as const;

/** keep: read it. tooLarge: over its cap. unsupported: no reader for its kind. hidden: archive junk or a dotfile. */
export type FileVerdict = 'keep' | 'tooLarge' | 'unsupported' | 'hidden';

/** The phone's readers by extension (LabFileReader.document): PDF and pictures. */
const PHONE_FILE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'heic'];
/** What the phone reads inside a ZIP (LabFileReader.isReport): no .heic. */
const PHONE_MEMBER_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];

/** The last path component's extension, lowercased, as Swift's `pathExtension` reads it: '' for none or a leading dot alone. */
function extensionOf(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/**
 * One picked file (or one ZIP member once inflated) by its name and size. `kind`: 'zip'
 * for a ZIP as picked, 'file' otherwise; left out, the name's extension says (the phone's rule).
 * The size comes first, as both clients check it before they read. Kind by name is the
 * phone's rule: the web's readers decide by name and MIME type (upload-pipeline readPages),
 * so on the web this verdict is keep or tooLarge. Neither client hides a dot name picked
 * on its own, so 'hidden' is a ZIP member's verdict only (zipMemberVerdict).
 */
export function fileVerdict({ name, bytes, kind, platform }: { name: string; bytes: number; kind?: 'file' | 'zip'; platform: UploadPlatform }): FileVerdict {
  const limits = UPLOAD_LIMITS[platform];
  const zip = (kind ?? (extensionOf(name) === 'zip' ? 'zip' : 'file')) === 'zip';
  if (bytes > (zip ? limits.zipBytes : limits.fileBytes)) return 'tooLarge';
  if (zip || platform === 'web') return 'keep';
  return PHONE_FILE_EXTENSIONS.includes(extensionOf(name)) ? 'keep' : 'unsupported';
}

/**
 * A ZIP member by its path. web: health-core's isImportableEntryName (any dot segment,
 * junk lowercased). phone: a dot last component or a case-sensitive `__MACOSX` hides it
 * (LabFileReader's rule, D9: kept as it is until a decision changes it).
 */
export function zipMemberVerdict(path: string, platform: UploadPlatform): FileVerdict {
  if (platform === 'web') {
    if (isImportableEntryName(path)) return 'keep';
    // With a readable extension added, only the junk and dotfile rules can still refuse it.
    return isImportableEntryName(`${path}.pdf`) ? 'unsupported' : 'hidden';
  }
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (path.includes('__MACOSX') || last.startsWith('.')) return 'hidden';
  return PHONE_MEMBER_EXTENSIONS.includes(extensionOf(path)) ? 'keep' : 'unsupported';
}
