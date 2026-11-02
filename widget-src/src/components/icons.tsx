/**
 * US-62 AC15: the iPhone's colour on the web. Each My data section's title
 * carries a tinted symbol (ios/HealthRoadmap/MyData/SectionTitle.swift), and
 * each plan card leads with its category's symbol on a tinted rounded square
 * (ios/HealthRoadmap/Plan/PlanCardView.swift, CategoryIcon). Same meanings and
 * Apple's system colours; the shapes are our own simple drawings, never traced
 * from SF Symbols (Apple's licence; docs/reference.md, 2026-10-25). Decorative:
 * hidden from screen readers, as on the iPhone; the title beside says it.
 */
import type { CSSProperties, ReactNode } from 'react';

type IconName = 'person' | 'heart' | 'drop' | 'pills' | 'stethoscope' | 'leaf' | 'folder'
  | 'fork' | 'run' | 'moon' | 'sun' | 'sparkles';

/** Apple's system colours (light appearance), as the iPhone tints them. */
const TINTS = {
  red: [255, 59, 48], orange: [255, 149, 0], yellow: [255, 204, 0], green: [52, 199, 89],
  mint: [0, 199, 190], teal: [48, 176, 199], blue: [0, 122, 255], indigo: [88, 86, 214],
  purple: [175, 82, 222], pink: [255, 45, 85], gray: [142, 142, 147],
} as const;
type Tint = keyof typeof TINTS;

const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const SHAPES: Record<IconName, ReactNode> = {
  person: <path fillRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm-6 11.3c1.3-2 3.5-3.3 6-3.3s4.7 1.3 6 3.3a8 8 0 0 1-12 0Z"/>,
  heart: <path d="M12 21s-7.4-4.6-9.3-9.3C1.3 8.2 3.4 4.5 7 4.5c2.1 0 3.6 1.1 5 2.9 1.4-1.8 2.9-2.9 5-2.9 3.6 0 5.7 3.7 4.3 7.2C19.4 16.4 12 21 12 21Z"/>,
  drop: <path d="M12 2.5c3.2 4.3 7 8.8 7 12.5a7 7 0 0 1-14 0c0-3.7 3.8-8.2 7-12.5Z"/>,
  pills: <g transform="rotate(-45 12 12)"><path d="M12 8.5H7a3.5 3.5 0 0 0 0 7h5Z"/><path d="M12 8.5h5a3.5 3.5 0 0 1 0 7h-5Z" opacity="0.55"/></g>,
  stethoscope: <g {...line}><path d="M5 3v5a4 4 0 0 0 8 0V3"/><path d="M9 12v2.5a5 5 0 0 0 10 0V12"/><circle cx="19" cy="10" r="2"/></g>,
  leaf: <g><path d="M20 3.5C11 3.5 5 7.5 5 14c0 2.2.8 4 1.8 5.2C14.5 20 20.5 14 20 3.5Z"/><path {...line} d="M4 21c3-5 6-8 10-11"/></g>,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/>,
  fork: <g {...line}><path d="M7 3v5a2 2 0 0 0 4 0V3M9 10v11"/><path d="M17 21V3c-2.2 1.8-3 4.6-3 8h3"/></g>,
  run: <g><circle cx="15" cy="4.5" r="2.2"/><path {...line} d="M7 9.5l4-2 3 2 2.5 3H19M14 9.5l-2.5 5 3 2.5-1.5 4.5M11.5 14.5L9 18H5"/></g>,
  moon: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>,
  sun: <g><circle cx="12" cy="12" r="4.5"/><path {...line} d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g>,
  sparkles: <g><path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8Z"/><path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9Z"/></g>,
};

function Icon({ name, size }: { name: IconName; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      {SHAPES[name]}
    </svg>
  );
}

const rgb = (tint: Tint, alpha = 1) => `rgba(${TINTS[tint].join(', ')}, ${alpha})`;

/** The My data sections, as SectionTitle.swift names and tints them. */
const SECTIONS = {
  aboutYou: ['person', 'orange'],
  vitals: ['heart', 'red'],
  bloodTests: ['drop', 'blue'],
  medications: ['pills', 'teal'],
  screening: ['stethoscope', 'indigo'],
  supplements: ['leaf', 'green'],
  record: ['folder', 'gray'],
} as const satisfies Record<string, readonly [IconName, Tint]>;
export type SectionKey = keyof typeof SECTIONS;

/** A section title's tinted symbol, before its words. */
export function SectionIcon({ section }: { section: SectionKey }) {
  const [name, tint] = SECTIONS[section];
  return <span className="section-icon" data-icon={name} aria-hidden="true" style={{ color: rgb(tint) }}><Icon name={name} size={20}/></span>;
}

/** The plan's categories, as CategoryIcon.style(for:) maps them; anything else, sparkles. */
const CATEGORIES: Record<string, readonly [IconName, Tint]> = {
  nutrition: ['fork', 'green'],
  exercise: ['run', 'orange'],
  bloodwork: ['drop', 'red'],
  blood_pressure: ['heart', 'pink'],
  sleep: ['moon', 'indigo'],
  medication: ['pills', 'teal'],
  screening: ['stethoscope', 'blue'],
  supplements: ['leaf', 'mint'],
  skin: ['sun', 'yellow'],
};

/** A plan card's category symbol on a 40px rounded square, its tint at 14%. Drawn
 *  at 22px, the visual size of the iPhone's 17pt semibold symbol. */
export function CategoryIcon({ category }: { category: string }) {
  const [name, tint] = CATEGORIES[category] ?? ['sparkles', 'purple'];
  const style: CSSProperties = { color: rgb(tint), background: rgb(tint, 0.14) };
  return <span className="category-icon" data-icon={name} aria-hidden="true" style={style}><Icon name={name} size={22}/></span>;
}
