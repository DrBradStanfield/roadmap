/**
 * The single-topic widgets' entry (US-74 AC8): one bundle, `health-widgets.js`,
 * for every theme block whose root carries `data-widget`. It opens the same
 * record the full app opens (boot, as app.tsx), then mounts each block's
 * widget by its topic (src/widgets/router.tsx). A page with no known topic
 * opens nothing.
 *
 * The block schema declares the script, so Shopify loads it once per page
 * (review C9); it still starts once and mounts each block once (review U1). Every block shows a loading line while the record
 * opens, and the failure panel if it does not (review U4), with no doctor's
 * name or address, as the commerce store carries none (review U5).
 */
import '../src/components/fields.css'; // the full app's field styles, first, so the widget's layout follows them
import '../src/widgets/widgets.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initRoadmapStore } from '../src/lib/roadmap-data';
import { FollowErase } from '../src/widgets/FollowErase';
import { widgetFor } from '../src/widgets/router';
import { boot } from './boot';
import { LoadFailurePanel } from './load-failure';
import { registerPageDeparture } from './page-departure';
import { resolveBackend } from './resolve-backend';

/** Set on the window by the first run: every copy of this script on the page shares it. */
const STARTED = Symbol.for('health-widgets.started');

const failure = (error: unknown) => <LoadFailurePanel error={error} neutral className="hr-widget-failure" />;

export async function startWidgets(doc: Document = document): Promise<void> {
  const page = window as unknown as Record<symbol, boolean | undefined>;
  if (page[STARTED]) return;
  // The blocks this build knows, in page order, each with its widget.
  const blocks = [...doc.querySelectorAll<HTMLElement>('.hr-widget[data-widget]')]
    .flatMap((el) => { const Widget = widgetFor(el.dataset.widget); return Widget ? [{ el, Widget }] : []; });
  if (blocks.length === 0) return;
  page[STARTED] = true;
  const mounts = blocks.map(({ el, Widget }) => ({ el, Widget, root: createRoot(el) }));
  for (const { root } of mounts) root.render(<p className="hr-widget-loading" role="status">Loading…</p>);
  try {
    // The failure is said in these blocks below, never in the full app's root (review C10).
    await boot(resolveBackend, initRoadmapStore, (error) => { throw error; });
  } catch (error) {
    for (const { root } of mounts) root.render(failure(error));
    return;
  }
  // Persist before the tab goes away, as the full app does.
  registerPageDeparture(() => {});
  for (const { el, root, Widget } of mounts) {
    root.render(
      <React.StrictMode>
        <ErrorBoundary feature="single-topic-widget" fallback={failure(new Error('render'))}>
          <FollowErase><Widget nextUrl={el.dataset.nextUrl} nextLabel={el.dataset.nextLabel} /></FollowErase>
        </ErrorBoundary>
      </React.StrictMode>,
    );
  }
}

/** Start once the page's markup is parsed: the block schema loads this script
 *  once per page (review C9), which may run before the blocks are in the DOM. */
export function whenReady(start: () => void, doc: Document = document): void {
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

// Never an unhandled rejection: every failure above is already on the page (review U4).
whenReady(() => { void startWidgets().catch(() => undefined); });
