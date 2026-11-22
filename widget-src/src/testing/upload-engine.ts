// Test support: the shared engine a test's stand-in upload bundle carries, as the real bundle does (upload-entry.ts), so
// the mounted list draws its review and the Save runs with it. Imported by tests only.
import { uploadReview } from '@roadmap/health-core/upload-review';
import { uploadSave } from '@roadmap/health-core/upload-save';

export const UPLOAD_ENGINE = { uploadReview, uploadSave };
