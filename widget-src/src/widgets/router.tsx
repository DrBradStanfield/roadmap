// The one router for every single-topic widget (US-74 AC8): a block names its
// topic in `data-widget`, and the next topic adds a component here, not a bundle.
import type { ComponentType } from 'react';
import { WaistToHeightWidget, type WidgetProps } from './WaistToHeight';

const WIDGETS: Record<string, ComponentType<WidgetProps>> = {
  'waist-to-height': WaistToHeightWidget,
};

/** The component for a `data-widget` value, or null for one this build does not know. */
export function widgetFor(name: string | undefined): ComponentType<WidgetProps> | null {
  return name !== undefined && Object.prototype.hasOwnProperty.call(WIDGETS, name) ? WIDGETS[name] : null;
}
