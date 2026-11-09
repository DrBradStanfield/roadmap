// My health's section list on desktop (US-62 AC27, Brad 2026-11-06): the
// sections the page holds, in order, sticky beside them; the one being read
// is marked (aria-current), and a red dot marks one holding an urgent card.
// Not drawn on a phone, where the three jump pills stay (iPhone parity; no room for more, US-62 AC33).
import { useEffect, useState } from 'react';
import { observeVisibility } from '../lib/observe-visibility';
import { useIsMobile } from '../lib/useIsMobile';

export interface NavTopic { id: string; title: string; urgent: boolean }

/** The heading a section is reached by: `mh-topic-<id>`, TopicHeading's id. */
const headingOf = (id: string) => document.getElementById(`mh-topic-${id}`);

/** The line near the top a heading must pass to make its section the one being read. */
const readingLine = () => Math.min(160, window.innerHeight * 0.3);

/** The section being read: the last whose heading has passed the reading line. */
function currentTopic(topics: NavTopic[]): string | undefined {
  const line = readingLine();
  let current = topics[0]?.id;
  for (const t of topics) {
    const heading = headingOf(t.id);
    if (heading && heading.getBoundingClientRect().top <= line) current = t.id;
  }
  return current;
}

export function SectionNav({ topics, onJump }: { topics: NavTopic[]; onJump: (id: string) => void }) {
  const [active, setActive] = useState<string | undefined>(topics[0]?.id);
  const isMobile = useIsMobile();
  const key = topics.map(t => t.id).join(' ');
  // A heading crossing the band near the top of the screen (the viewport, whatever element
  // scrolls: the storefront's theme scrolls a wrapper) re-reads which section is being read.
  // Desktop only: a phone shows the pills, and its list does no work.
  useEffect(() => {
    if (isMobile) return;
    const update = () => setActive(currentTopic(topics));
    const stops = topics.flatMap(t => {
      const heading = headingOf(t.id);
      // The band ends at the reading line, so a heading fires as it crosses it, not short of it.
      const rootMargin = `0px 0px ${-Math.round(window.innerHeight - readingLine())}px 0px`;
      return heading ? [observeVisibility(heading, update, { rootMargin })] : [];
    });
    return () => { for (const stop of stops) stop(); };
  }, [key, isMobile]);
  if (isMobile) return null;
  return (
    <nav className="mh-nav no-print" aria-label="My health sections">
      <ul className="mh-nav-list">
        {topics.map(t => (
          <li key={t.id}>
            <a
              href={`#mh-topic-${t.id}`}
              className={`mh-nav-link${active === t.id ? ' mh-nav-link--active' : ''}`}
              aria-current={active === t.id ? 'location' : undefined}
              onClick={e => { e.preventDefault(); setActive(t.id); onJump(t.id); }}
            >
              <span className="mh-nav-title">{t.title}</span>
              {t.urgent && <span className="mh-nav-dot"><span className="hr-sr-only">, needs attention</span></span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
