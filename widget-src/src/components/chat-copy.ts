import { getAssistantName, getChatSurface } from '../lib/assistant-config';

// US-15 AC12: the brand store has no plan, so its chat names products. The
// brand words read the metafield-set assistant name at render, not import.
// `heading` is the inline panel's column heading; the pop-up has none.
const SURFACE_COPY = {
  doctor: {
    label: 'Health by Dr Brad Chat',
    title: 'Discuss your health',
    heading: 'Ask about your plan',
    subtitle: 'Answers cite your plan & the guidelines above',
    empty: 'Ask about your personalized suggestions based on your health data, clinical research, and the preventative care algorithm.',
    collapsed: 'Ask about your health suggestions',
  },
  brand: {
    get label() { return `${getAssistantName()} chat`; },
    get title() { return `Ask ${getAssistantName()}`; },
    heading: 'Ask about our products',
    subtitle: 'Products, ingredients, and the research behind them',
    empty: "Ask what's in a product, how to take it, or what the evidence says about an ingredient. For orders and subscriptions, sign in to your account.",
    collapsed: 'Ask about our products',
  },
};

/** The chat's words for this store, the pop-up's and the inline panel's alike (US-15 AC77): one rule, the store's
 *  chat surface (`getChatSurface`, from the `data-surface` its Liquid block emits). */
export function chatCopy() {
  return SURFACE_COPY[getChatSurface()];
}
