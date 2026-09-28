#!/usr/bin/env tsx
/**
 * Is there a Sonnet newer than the pinned chat model? (docs/chat-audit-2026-09-29.md §4.3)
 *
 * Lists the Anthropic Models API and reports every `claude-sonnet-*` id whose
 * created_at is newer than the pinned CHAT_MODEL's, plus the harness commands
 * that qualify a candidate for the answer hop. It never changes the pin: a
 * bump goes through a `claude/` PR, labelled `hold` for Brad's merge, with the
 * harness numbers (product-health loop charter, US-15 AC18).
 *
 * Usage:
 *   export $(grep -E "^ANTHROPIC_(TEST_)?API_KEY=" .env | xargs) && npx tsx tools/check-newer-model.ts
 *
 * Exit 0 = nothing newer, 10 = a newer Sonnet exists, 1 = API or lookup failure.
 */
import { pathToFileURL } from 'url';
import { CHAT_MODEL } from '../packages/health-core/src/models';

export interface ModelInfo {
  id: string;
  created_at: string;
}

/** Sonnets released after the pinned model, newest first. Throws if the pin is not in the list. */
export function newerSonnets(models: ModelInfo[], pinnedId: string): ModelInfo[] {
  const pinned = models.find(m => m.id === pinnedId);
  if (!pinned) throw new Error(`pinned model ${pinnedId} is not in the Models API list`);
  const pinnedAt = Date.parse(pinned.created_at);
  return models
    .filter(m => m.id.startsWith('claude-sonnet-') && Date.parse(m.created_at) > pinnedAt)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let after = '';
  for (;;) {
    const res = await fetch(`https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${after}` : ''}`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`GET /v1/models: HTTP ${res.status}`);
    const page = await res.json() as { data: ModelInfo[]; has_more: boolean; last_id: string | null };
    out.push(...page.data);
    if (!page.has_more || !page.last_id) return out;
    after = page.last_id;
  }
}

const day = (iso: string) => iso.slice(0, 10);

/** The answer-hop qualification commands, then the router and classifier ones, marked. */
export function qualificationLines(id: string): string[] {
  return [
    `Qualify ${id} for the answer hop before a pin-bump PR (labelled hold, for Brad's merge):`,
    `  npx tsx tools/test-chatbot-matching.ts --answer-model ${id} --runs 3 --answer-check`,
    `  npx tsx tools/test-tool-edits.ts --model ${id}`,
    'Run these only if the router or classifier pin is changed:',
    `  npx tsx tools/test-chatbot-matching.ts --model ${id} --runs 3`,
    `  npx tsx tools/test-classifier.ts --model ${id}`,
  ];
}

export async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_TEST_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_TEST_API_KEY or ANTHROPIC_API_KEY must be set');
    return 1;
  }
  console.log(`Using ${process.env.ANTHROPIC_TEST_API_KEY ? 'ANTHROPIC_TEST_API_KEY (test workspace)' : 'ANTHROPIC_API_KEY (production key — billing shared with prod)'}`);
  let models: ModelInfo[];
  let newer: ModelInfo[];
  try {
    models = await listModels(apiKey);
    newer = newerSonnets(models, CHAT_MODEL);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
  console.log(`Pinned CHAT_MODEL: ${CHAT_MODEL} (${day(models.find(m => m.id === CHAT_MODEL)!.created_at)})`);
  if (newer.length === 0) {
    console.log('No newer claude-sonnet-* model.');
    return 0;
  }
  console.log('Newer Sonnets:');
  for (const m of newer) console.log(`  ${m.id} (${day(m.created_at)})`);
  for (const line of qualificationLines(newer[0].id)) console.log(line);
  return 10;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code));
}
