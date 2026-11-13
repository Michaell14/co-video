import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { Button } from '../components/Button';
import { Cursor } from '../components/Cursor';
import { GithubMark } from '../components/GithubMark';
import { Reveal } from '../components/Reveal';
import { useLoopActive } from '../lib/hooks';
import { EDITOR_URL, GITHUB_URL } from '../lib/links';
import './FinalCta.css';

/**
 * Collaborators drifting around the headline. Where the page is too narrow to leave room beside
 * the headline and the buttons, two of them move aside and two step out.
 */
const CURSORS = [
  { name: 'Maya', color: '#ff5d5d', x: '14%', y: '26%', drift: 9 },
  { name: 'Jonas', color: '#22d3ee', x: '80%', y: '20%', drift: 11, narrow: { x: '66%', y: '9%' } },
  { name: 'Aiko', color: '#ff9f43', x: '20%', y: '72%', drift: 13 },
  { name: 'You?', color: '#c6f84f', x: '74%', y: '70%', drift: 10, narrow: { x: '12%', y: '88%' } },
];

export function FinalCta() {
  const ref = useRef<HTMLElement>(null);
  const active = useLoopActive(ref);

  return (
    <section className="cta" aria-labelledby="cta-title" ref={ref} data-active={active}>
      <div className="cta__backdrop" aria-hidden="true">
        <div className="cta__grid" />
        {/* The logo, enormous: two play triangles that drift apart and back, in tandem. */}
        <svg className="cta__mark" viewBox="0 0 64 64" fill="none" focusable="false">
          <path
            className="cta__tri cta__tri--violet"
            d="M17 18.5c0-2.3 2.5-3.7 4.5-2.6l19 11c2 1.2 2 4 0 5.2l-19 11c-2 1.1-4.5-.3-4.5-2.6v-22z"
          />
          <path
            className="cta__tri cta__tri--lime"
            d="M27 21.5c0-2.3 2.5-3.7 4.5-2.6l19 11c2 1.2 2 4 0 5.2l-19 11c-2 1.1-4.5-.3-4.5-2.6v-22z"
          />
        </svg>
        <div className="grain" />
        {CURSORS.map((cursor) => (
          <div
            key={cursor.name}
            className="cta__cursor"
            data-narrow={cursor.narrow !== undefined}
            style={
              {
                '--x': cursor.x,
                '--y': cursor.y,
                '--narrow-x': cursor.narrow?.x,
                '--narrow-y': cursor.narrow?.y,
                '--drift': `${cursor.drift}s`,
              } as CSSProperties
            }
          >
            <Cursor name={cursor.name} color={cursor.color} />
          </div>
        ))}
      </div>

      <div className="container cta__inner">
        <Reveal>
          <h2 className="cta__title display" id="cta-title">
            Open a tab.
            <br />
            <em>Start cutting.</em>
          </h2>
        </Reveal>
        <Reveal delay={0.1} as="p" className="lead">
          No download and no sign-up. Bring your footage, then bring your people.
        </Reveal>
        <Reveal delay={0.18} className="cta__actions">
          <Button href={EDITOR_URL} size="lg">
            Open the editor
            <ArrowRight className="btn__arrow" size="1.1em" strokeWidth={2.4} aria-hidden="true" />
          </Button>
          <Button href={GITHUB_URL} variant="ghost" size="lg" external>
            <GithubMark />
            Star on GitHub
          </Button>
        </Reveal>
      </div>
    </section>
  );
}
