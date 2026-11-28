// A topic master's safety sections, one rule for every reader: the connector's
// get_article cut (US-41 AC8) and the web chat's reduced master and YouTube's
// safety sections (US-50 AC13a).

/** A heading naming a risk (safety, side effects, toxicity, interactions, who should take care or not take it), at any level from `##`. */
const SAFETY_HEADING = /^(#{2,6}) .*\b(?:safety|side effects?|toxicity|interactions?|contraindications?|precautions?|adverse|cautions?|warnings?|pregnancy|special populations?|risk factors?|who should not)\b.*$/gim;

/**
 * Every safety block of a body: a matching heading to the next heading of its
 * level or higher. A block inside one already taken is not taken again.
 */
export function safetyBlocks(body: string): string[] {
  const blocks: string[] = [];
  let taken = -1;
  for (const m of body.matchAll(SAFETY_HEADING)) {
    if (m.index! < taken) continue;
    const rest = body.slice(m.index! + m[0].length);
    const next = rest.search(new RegExp(`^#{2,${m[1].length}} `, 'm'));
    taken = m.index! + m[0].length + (next === -1 ? rest.length : next);
    blocks.push(body.slice(m.index!, taken).trim());
  }
  return blocks;
}
