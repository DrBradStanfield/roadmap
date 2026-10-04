import type { ReactNode } from 'react';

interface ColumnHeaderProps {
  step: number;
  title: string;
  meta: ReactNode;
  muted?: boolean;
  /** US-44 AC6: on a phone, keep this header's actions (title and step hide). */
  actions?: boolean;
}

export function ColumnHeader({ step, title, meta, muted, actions }: ColumnHeaderProps) {
  return (
    <div className={`hr-col-header${muted ? ' hr-col-header--muted' : ''}${actions ? ' hr-col-header--actions' : ''}`}>
      <div className="hr-col-title">
        <span className="hr-col-step">{step}</span>
        {title}
      </div>
      <div className="hr-col-meta">{meta}</div>
    </div>
  );
}
