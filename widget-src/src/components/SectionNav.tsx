// My health's section list on desktop (US-62 AC27, Brad 2026-11-06): the
// sections the page holds, in order, sticky beside them; the one being read
// is marked (aria-current), and a red dot marks one holding an urgent card.
// Hidden on a phone, where the three jump pills stay (iPhone parity).
import { useEffect, useRef, useState } from 'react';

export interface NavTopic { id: string; title: string; urgent: boolean }

/** The heading a section is reached by: `mh-topic-<id>`, TopicHeading's id. */
const headingOf = (id: string) => document.getElementById(`mh-topic-${id}`);

/** The section being read: the last whose heading has passed a line near the top. */
function currentTopic(topics: NavTopic[]): string | undefined {
  const line = Math.min(160, window.innerHeight * 0.3);
  let current = topics[0]?.id;
  for (const t of topics) {
    const heading = headingOf(t.id);
    if (heading && heading.getBoundingClientRect().top <= line) current = t.id;
  }
  return current;
}

export function SectionNav({ topics, onJump }: { topics: NavTopic[]; onJump: (id: string) => void }) {
  const navRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | undefined>(topics[0]?.id);
  const key = topics.map(t => t.id).join(' ');
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      // Only where the list shows (desktop): a phone's hidden list does no work.
      if (navRef.current?.offsetParent === null) return;
      setActive(currentTopic(topics));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    // Capture: the storefront's theme scrolls a wrapper, not the window.
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);
  return (
    <nav className="mh-nav no-print" aria-label="My health sections" ref={navRef}>
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
