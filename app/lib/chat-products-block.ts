/**
 * The text of the third cached system block: products.md, then the shared
 * writing style and the answer bank. All four cache breakpoints are in use, so
 * the two shared files ride inside this block instead of a fifth one.
 *
 * Shared by chat.server.ts (production) and tools/test-chatbot-matching.ts
 * (the harness), so both send the same text. No server imports: tsx loads it.
 *
 * docs/writing-style.md and docs/chatbot/answer-bank.md come from the private
 * claude_business repo (its tools/sync-shared-docs.mjs); never edit them here.
 * The prompt rules that use them are in chat-system-prompt.md.
 *
 * The answer bank is for the two websites only (US-15 AC29): the YouTube and
 * Discord bots build this block without it and cache their own variant.
 */
export const PRODUCTS_BLOCK_FILES = {
  products: 'docs/products.md',
  writingStyle: 'docs/writing-style.md',
  answerBank: 'docs/chatbot/answer-bank.md',
} as const;

export function productsBlockText(docs: { products: string; writingStyle: string; answerBank?: string }): string {
  return [
    docs.products && `## Dr Stanfield's Products\n\n${docs.products}`,
    docs.writingStyle && `## WRITING STYLE (applies to every answer)\n\n${docs.writingStyle}`,
    docs.answerBank && `## ANSWER BANK (approved answers to customer questions)\n\n${docs.answerBank}`,
  ].filter(Boolean).join('\n\n---\n\n');
}
