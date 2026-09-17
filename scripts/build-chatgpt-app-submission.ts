/**
 * Generate the two ChatGPT-app artefacts from one source, so neither can drift
 * from the code:
 *
 *   docs/chatgpt-app-submission.json   the optional upload the OpenAI form takes
 *   docs/guides/chatgpt-app.md         the public page, published like any guide
 *
 * Tool names, titles and annotations come from `MCP_TOOLS`, the prompts from
 * `MCP_PROMPTS`, and the prose from `docs/chatgpt-app-submission.source.ts`.
 * Nothing here is retyped from the listing doc.
 *
 * Usage: npx tsx scripts/build-chatgpt-app-submission.ts
 * Then:  node scripts/build-guide-html.mjs docs/guides/chatgpt-app.md
 *
 * `build-chatgpt-app-submission.test.ts` regenerates both and fails if what is
 * committed differs, so a tool added or renamed in mcp-tools.ts fails the suite
 * until both artefacts are rebuilt.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, MCP_PROMPTS } from '../packages/health-core/src/mcp-tools';
import type { McpToolName } from '../packages/health-core/src/product-events';
import { APP_INFO, GUIDE, NEGATIVE_TEST_CASES, TEST_CASES, TOOL_PROSE } from '../docs/chatgpt-app-submission.source';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const JSON_PATH = join(root, 'docs', 'chatgpt-app-submission.json');
export const GUIDE_PATH = join(root, 'docs', 'guides', 'chatgpt-app.md');

const prose = (name: string) => {
  const found = TOOL_PROSE[name as McpToolName];
  if (!found) throw new Error(`${name} is in MCP_TOOLS but has no prose in docs/chatgpt-app-submission.source.ts`);
  return found;
};

/** The upload's shape, as documented in docs/chatgpt-app-listing.md. */
export function buildJson(): string {
  const tools = Object.fromEntries(
    MCP_TOOLS.map((tool) => [
      tool.name,
      {
        annotations: {
          readOnlyHint: tool.annotations.readOnlyHint,
          openWorldHint: tool.annotations.openWorldHint,
          destructiveHint: tool.annotations.destructiveHint,
        },
        justifications: {
          read_only_justification: prose(tool.name).readOnly,
          open_world_justification: prose(tool.name).openWorld,
          destructive_justification: prose(tool.name).destructive,
        },
      },
    ]),
  );
  // The form takes a URL per case; we attach none, and every field the schema
  // names is written rather than omitted, so a reviewer sees an answer to each.
  const cases = (list: typeof TEST_CASES) =>
    list.map((c) => ({
      description: c.description,
      user_prompt: c.user_prompt,
      file_attachment_urls: null,
      tools_triggered: c.tools_triggered,
      expected_output: c.expected_output,
      expected_output_url: null,
    }));

  return `${JSON.stringify(
    {
      $schema: 'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
      schema_version: 1,
      app_info: APP_INFO,
      tools,
      test_cases: cases(TEST_CASES),
      negative_test_cases: cases(NEGATIVE_TEST_CASES),
    },
    null,
    2,
  )}\n`;
}

/** The guide master. The guide builder turns this into the page. */
export function buildGuide(): string {
  const tools = MCP_TOOLS.map((tool) => {
    const { does, never } = prose(tool.name);
    return `### \`${tool.name}\`: ${tool.title}\n\n${does}\n\n**What it will not do.** ${never}`;
  }).join('\n\n');

  // Each prompt's own words go in a fenced block: it is the text the client
  // sends, quoted rather than paraphrased, and a fence is also the one place a
  // published page may carry punctuation the prose guard refuses.
  const prompts = MCP_PROMPTS.map((p) => `**${p.title}**\n\n\`\`\`\n${p.text}\n\`\`\``).join('\n\n');

  const front = [
    '---',
    `title: "${GUIDE.title}"`,
    `description: "${GUIDE.description}"`,
    `slug: "${GUIDE.slug}"`,
    `updated: "${GUIDE.updated}"`,
    `stories: [${GUIDE.stories.map((s) => `"${s}"`).join(', ')}]`,
    '---',
  ].join('\n');

  const body = GUIDE.body.replace('{{tools}}', tools).replace('{{prompts}}', prompts);
  return `${front}\n\n${body}\n`;
}

/** True when the committed file already holds exactly what we would write. */
export const current = (path: string, built: string) => existsSync(path) && readFileSync(path, 'utf8') === built;

function main(): void {
  for (const [path, built] of [[JSON_PATH, buildJson()], [GUIDE_PATH, buildGuide()]] as const) {
    const same = current(path, built);
    if (!same) writeFileSync(path, built);
    console.log(`${same ? 'unchanged' : 'wrote'} ${path} (${built.length} bytes)`);
  }
}

const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : '';
if (entry === realpathSync(fileURLToPath(import.meta.url))) main();
