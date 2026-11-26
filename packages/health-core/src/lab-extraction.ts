/**
 * Shared lab/document extraction logic — the PURE pieces of the pipeline:
 * the unified system prompt, the LLM-response schema/parsing, and the
 * unit-resolution tables. No fetch, no env, no Sentry.
 *
 * Two consumers (moved here June 2026 so they can never drift):
 *  - app/lib/anthropic.server.ts — Brad's server (Shopify widget + the
 *    drstanfield.com v2 page), which wraps these with the server fetch,
 *    retries, batching, and Sentry.
 *  - widget-src/src/lib/byok-upload.ts — the standalone (GitHub Pages /
 *    self-host) build, which calls api.anthropic.com directly with the
 *    user's own key. This means the prompt ships in the public Pages
 *    bundle: Brad accepted that 2026-06-10 — it is mechanical value
 *    extraction, not clinical IP (the algorithm doc never leaves the server).
 */
// The extraction pieces live in their own modules; these keep the old import paths working.
export { DOCUMENT_CLASSIFICATIONS, EXTRACTION_MAX_TOKENS, UNDATED_PREVIOUS, UNIFIED_SYSTEM_PROMPT, unifiedSystemPrompt, unreadLines } from './lab-extraction-contract';
export type { AdditionalLabValue, DocumentPromptMode, DocumentResult, ExtractedValue, PageContent, RefusedLabValue, UnifiedExtractionResult, UnreadLabValue, UnreadReason } from './lab-extraction-contract';
export { CORE_METRIC_ALIASES, isUrineOrRatioUnit, labSearch, resolveCoreMetricName, resolveLabValues, resolveName, resolveUnit, VALID_METRICS } from './lab-extraction-units';
export type { LabSearchMatch, ResolvedName } from './lab-extraction-units';
export { extractJsonObject, MAX_NAME_LENGTH, pagesToContentBlocks, parseExtractionJson, parseUnifiedResult, stripCodeFences, toUnifiedResult } from './lab-extraction-parse';
export { fileNameLine, FOLDER_IMPORT_EXTENSIONS, IMPORTABLE_EXTENSIONS, inflateCapped, isImportableEntryName, LIMIT_TEST_WORDS, MAX_FILE_NAME_LENGTH, uploadLimitSignal, zipMemberName } from './lab-extraction-files';
