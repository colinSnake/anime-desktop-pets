import { useEffect, useState, type ReactNode } from 'react';
import { longmei } from '../../../../packages/contracts/src/built-in-pets.ts';
import { PetCover } from '../PetCover.tsx';
import { PetNookIcon } from '../PetNookIcon.tsx';

type InteractionPage = 'speech' | 'live' | 'advanced';

export function InteractionLayout({ page, title, description, appearance, toast, children }: {
  page: InteractionPage; title: string; description?: string; appearance?: ReactNode; toast?: string; children: ReactNode;
}) {
  return <div className="interaction-page" data-interaction={page}>
    <InteractionToast message={toast ?? ''} />
    <header className="interaction-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{appearance}</header>
    <div className="interaction-body">{children}</div>
  </div>;
}

export function InteractionToast({ message, duration = 3600 }: { message: string; duration?: number }) {
  const [visible, setVisible] = useState(!!message);
  useEffect(() => {
    if (!message) { setVisible(false); return; }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer);
  }, [message, duration]);
  if (!message || !visible) return null;
  return <div className="interaction-toast" role="alert" aria-live="assertive" aria-atomic="true">{message}</div>;
}

export function InteractionHero({ page, eyebrow, title, description, children }: {
  page: 'speech'; eyebrow: string; title: string; description?: string; children: ReactNode;
}) {
  return <section className="interaction-hero" aria-labelledby={`${page}-hero-title`}>
    <div className="interaction-hero-copy">
      <span className="interaction-eyebrow"><PetNookIcon name="audio" />{eyebrow}</span>
      <h2 id={`${page}-hero-title`}>{title}</h2>{description && <p>{description}</p>}{children}
    </div>
    <div className="interaction-art" aria-hidden="true">
      <span className="interaction-halo" /><span className="interaction-orbit" /><span className="interaction-orbit second" />
      <span className="interaction-star top"><PetNookIcon name="spark" /></span>
      <span className="interaction-star bottom"><PetNookIcon name="spark" /></span>
      <span className="interaction-sticker"><PetNookIcon name="audio" /></span>
      <PetCover reference={longmei} />
    </div>
  </section>;
}

export function InteractionCardHeading({ id, title, description, context }: {
  id: string; title: string; description?: string; context?: string;
}) {
  return <div className="interaction-card-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>
    {context && <span className="interaction-pill muted">{context}</span>}
  </div>;
}
