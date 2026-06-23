/**
 * Per-store assistant display name (e.g. "Brad AI" vs "MicroVitamin").
 *
 * Both Shopify stores (education + commerce) load the SAME extension bundle, so
 * the chatbot's display name can't be hardcoded. Each store's widget/chat root
 * element carries a `data-assistant-name` attribute, populated from a shop
 * metafield (`health_roadmap.chat_assistant_name`) in the Liquid block. At boot,
 * each entry reads that attribute via `resolveAssistantName(rootEl)` and stores
 * it here as a module-level value; `ChatMessageBubble` reads it back with
 * `getAssistantName()`. No prop-drilling, no context.
 *
 * Defaults to "Brad AI" when no attribute/metafield is set (the education store).
 */

export const DEFAULT_ASSISTANT_NAME = 'Brad AI';

let assistantName = DEFAULT_ASSISTANT_NAME;

/**
 * Read the assistant name from a root element's `data-assistant-name`, falling
 * back to the default when absent or blank. Pure — does not mutate module state.
 */
export function resolveAssistantName(root: HTMLElement | null): string {
  const value = root?.dataset.assistantName?.trim();
  return value ? value : DEFAULT_ASSISTANT_NAME;
}

/** Set the active assistant name at boot (typically from `resolveAssistantName`). */
export function setAssistantName(name: string): void {
  assistantName = name;
}

/** The active assistant name. Defaults to "Brad AI" until a boot entry sets it. */
export function getAssistantName(): string {
  return assistantName;
}
