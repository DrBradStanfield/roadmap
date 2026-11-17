/**
 * The single-topic widgets' entry (US-74 AC8): one bundle, `health-widgets.js`,
 * for every theme block whose root carries `data-widget`. It opens the same
 * record the full app opens (boot, as app.tsx), then mounts each block's
 * widget by its topic (src/widgets/router.tsx). A page with no known topic
 * opens nothing.
 */
import '../src/widgets/widgets.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { initRoadmapStore } from '../src/lib/roadmap-data';
import { WidgetRoot, widgetFor } from '../src/widgets/router';
import { boot } from './boot';
import { registerPageDeparture } from './page-departure';
import { resolveBackend } from './resolve-backend';

/** The blocks this build knows, in page order. */
function widgetRoots(doc: Document = document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('.hr-widget[data-widget]')].filter((el) => widgetFor(el.dataset.widget));
}

async function main() {
  const roots = widgetRoots();
  if (roots.length === 0) return;
  await boot(resolveBackend, initRoadmapStore, roots[0]);
  // Persist before the tab goes away, as the full app does.
  registerPageDeparture(() => {});
  for (const root of roots) {
    createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <WidgetRoot name={root.dataset.widget} nextUrl={root.dataset.nextUrl} nextLabel={root.dataset.nextLabel} />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  }
}

void main();
