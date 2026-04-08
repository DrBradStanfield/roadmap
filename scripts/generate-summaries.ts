/**
 * One-time script to add `summary` fields to all blog article .md files
 * that are missing one.
 *
 * For each file:
 * - If a `## Overview` or `## 1. Overview` section exists, extract text from
 *   there until the next `##` heading.
 * - Otherwise, extract text from the start of the body until the first `##`
 *   heading (skipping "Read the full article..." source link lines).
 * - Trim to first 150 words, strip markdown links, collapse whitespace.
 * - Insert `summary: "..."` into frontmatter right before the closing `---`.
 *
 * Usage: npx tsx scripts/generate-summaries.ts
 */

import fs from 'fs';
import path from 'path';

const BLOG_DIR = path.join(process.cwd(), 'docs/blog');

function hasSummary(frontmatterBlock: string): boolean {
  return /^summary:/m.test(frontmatterBlock);
}

/**
 * Extract raw text for the summary from the markdown body.
 *
 * Priority:
 * 1. `## Overview` or `## 1. Overview` (with optional bold markers) section
 * 2. Text before the first `##` heading
 */
function extractRawText(body: string): string {
  // Try to find an Overview section (handles ## Overview, ## **Overview**, ## 1. Overview, etc.)
  const overviewMatch = body.match(/^##\s+\**(?:1\.\s*)?Overview\**\s*\n([\s\S]*?)(?=\n##\s|\n$)/m);
  if (overviewMatch) {
    return overviewMatch[1];
  }

  // Fall back to text before first ## heading
  const firstHeadingIdx = body.search(/^##\s/m);
  const textBeforeHeading = firstHeadingIdx === -1 ? body : body.slice(0, firstHeadingIdx);
  return textBeforeHeading;
}

/**
 * Clean up extracted text:
 * - Remove "Read the full article..." source link lines
 * - Strip markdown links [text](url) → text
 * - Strip reference markers like [1], [2][3], etc.
 * - Collapse whitespace
 * - Trim to first 150 words
 */
function cleanAndTruncate(raw: string): string {
  let text = raw;

  // Remove source link lines (e.g. *Read the full article at [...](...) *)
  text = text.replace(/^\s*\*Read the full article[^\n]*\*\s*$/gm, '');

  // Strip markdown links: [text](url) → text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Strip bold/italic markers
  text = text.replace(/\*\*/g, '');
  text = text.replace(/\*/g, '');

  // Strip reference markers like [1], [1][2], [1,2], [1-3]
  text = text.replace(/\[[\d,;\s\-–]+\]/g, '');

  // Remove space before punctuation (left behind after stripping refs like "word [1].")
  text = text.replace(/ +([.,;:!?)])/g, '$1');

  // Collapse whitespace (newlines, multiple spaces, etc.)
  text = text.replace(/\s+/g, ' ').trim();

  // Trim to first 150 words
  const words = text.split(/\s+/);
  if (words.length > 150) {
    text = words.slice(0, 150).join(' ');
    // End cleanly — don't cut mid-sentence if possible
    // Just add ellipsis since we're truncating
    text += '...';
  }

  return text;
}

/**
 * Escape a string for use as a YAML double-quoted value.
 * Escapes backslashes and double quotes.
 */
function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function main() {
  const files = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} .md files in ${BLOG_DIR}`);

  let alreadyHadSummary = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(BLOG_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Parse frontmatter boundaries
    const fmMatch = content.match(/^(---\n)([\s\S]*?\n)(---\n)/);
    if (!fmMatch) {
      console.warn(`  SKIP ${file} — no valid frontmatter`);
      skipped++;
      continue;
    }

    const fmOpen = fmMatch[1];     // "---\n"
    const fmBody = fmMatch[2];     // frontmatter content
    const fmClose = fmMatch[3];    // "---\n"
    const restOfFile = content.slice(fmMatch[0].length);

    // Check if summary already exists
    if (hasSummary(fmBody)) {
      alreadyHadSummary++;
      continue;
    }

    // Extract and clean summary text
    const rawText = extractRawText(restOfFile);
    const summary = cleanAndTruncate(rawText);

    if (!summary) {
      console.warn(`  SKIP ${file} — could not extract summary text`);
      skipped++;
      continue;
    }

    // Insert summary line right before the closing ---
    const summaryLine = `summary: "${escapeYamlString(summary)}"\n`;
    const newContent = fmOpen + fmBody + summaryLine + fmClose + restOfFile;

    fs.writeFileSync(filePath, newContent);
    updated++;
  }

  console.log(`\nDone!`);
  console.log(`  Total files:          ${files.length}`);
  console.log(`  Already had summary:  ${alreadyHadSummary}`);
  console.log(`  Updated:              ${updated}`);
  console.log(`  Skipped (no FM/text): ${skipped}`);
}

main();
