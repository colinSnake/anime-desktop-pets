import type { ReactNode } from 'react';
import { dafeiyu, longmei } from '../../../../packages/contracts/src/built-in-pets.ts';
import { PetCover } from '../PetCover.tsx';
import { PetNookIcon } from '../PetNookIcon.tsx';

type InteractionPage = 'speech' | 'live' | 'advanced';
type Icon = Parameters<typeof PetNookIcon>[0]['name'];

export function InteractionLayout({ page, title, description, appearance, children }: {
  page: InteractionPage; title: string; description: string; appearance?: ReactNode; children: ReactNode;
}) {
  return <div className="interaction-page" data-interaction={page}>
    <header className="interaction-heading"><div><h1>{title}</h1><p>{description}</p></div>{appearance}</header>
    <div className="interaction-body">{children}</div>
  </div>;
}

export function InteractionHero({ page, eyebrow, title, description, children }: {
  page: Exclude<InteractionPage, 'advanced'>; eyebrow: string; title: string; description: string; children: ReactNode;
}) {
  const icon = page === 'speech' ? 'audio' : 'live';
  return <section className="interaction-hero" aria-labelledby={`${page}-hero-title`}>
    <div className="interaction-hero-copy">
      <span className="interaction-eyebrow"><PetNookIcon name={icon} />{eyebrow}</span>
      <h2 id={`${page}-hero-title`}>{title}</h2><p>{description}</p>{children}
    </div>
    <div className="interaction-art" aria-hidden="true">
      <span className="interaction-halo" /><span className="interaction-orbit" /><span className="interaction-orbit second" />
      <span className="interaction-star top"><PetNookIcon name="spark" /></span>
      <span className="interaction-star bottom"><PetNookIcon name="spark" /></span>
      <span className="interaction-sticker"><PetNookIcon name={icon} /></span>
      <PetCover reference={page === 'speech' ? longmei : dafeiyu} />
    </div>
  </section>;
}

export function InteractionCardHeading({ id, title, description, context }: {
  id: string; title: string; description: string; context?: string;
}) {
  return <div className="interaction-card-heading"><div><h2 id={id}>{title}</h2><p>{description}</p></div>
    {context && <span className="interaction-pill muted">{context}</span>}
  </div>;
}

export function InteractionDisclosure({ title, icon, children }: { title: string; icon: Icon; children: ReactNode }) {
  return <details className="interaction-disclosure">
    <summary><PetNookIcon name={icon} /><span>{title}</span><PetNookIcon name="down" /></summary>{children}
  </details>;
}
