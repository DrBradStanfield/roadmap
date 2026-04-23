import type { ReactNode } from 'react';

interface ColumnHeaderProps {
  step: number;
  title: string;
  meta: ReactNode;
}

export function ColumnHeader({ step, title, meta }: ColumnHeaderProps) {
  return (
    <div className="hr-col-header">
      <div className="hr-col-title">
        <span className="hr-col-step">{step}</span>
        {title}
      </div>
      <div className="hr-col-meta">{meta}</div>
    </div>
  );
}
