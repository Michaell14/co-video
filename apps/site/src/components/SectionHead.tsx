import type { ReactNode } from 'react';
import { Reveal } from './Reveal';

interface SectionHeadProps {
  /** Two-digit chapter index, shown like a timeline marker. */
  index: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  id?: string;
}

/** Eyebrow, headline and lead paragraph that open every section. */
export function SectionHead({ index, eyebrow, title, lead, id }: SectionHeadProps) {
  return (
    <header className="section-head">
      <Reveal as="p" className="eyebrow" y={12}>
        <span className="eyebrow__marker" aria-hidden="true" />
        <span className="eyebrow__index" aria-hidden="true">
          {index}
        </span>
        {eyebrow}
      </Reveal>
      <Reveal delay={0.05}>
        <h2 className="h2" id={id}>
          {title}
        </h2>
      </Reveal>
      {lead ? (
        <Reveal delay={0.12} as="p" className="lead">
          {lead}
        </Reveal>
      ) : null}
    </header>
  );
}
