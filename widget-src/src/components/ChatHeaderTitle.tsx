import type { RefObject } from 'react';

interface ChatHeaderTitleProps {
  title?: string;
  subtitle: string;
  /** The pop-up chat's title takes the focus on opening (US-15 AC12a). */
  titleRef?: RefObject<HTMLHeadingElement>;
}

export function ChatHeaderTitle({ title = 'Discuss your health', subtitle, titleRef }: ChatHeaderTitleProps) {
  return (
    <div className="chat-header-title-block">
      <h3 ref={titleRef} tabIndex={titleRef ? -1 : undefined}>{title}</h3>
      <p className="chat-header-sub">{subtitle}</p>
    </div>
  );
}