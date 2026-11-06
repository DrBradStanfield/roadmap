import type { ReactNode } from 'react';

/** A column's header, the chat column's since My health has no columns 1 and 2 (US-62 AC16): no step number. */
interface ColumnHeaderProps {
  title: string;
  meta: ReactNode;
  muted?: boolean;
}

export function ColumnHeader({ title, meta, muted }: ColumnHeaderProps) {
  return (
    <div className={`hr-col-header${muted ? ' hr-col-header--muted' : ''}`}>
      <div className="hr-col-title">{title}</div>
      <div className="hr-col-meta">{meta}</div>
    </div>
  );
}
