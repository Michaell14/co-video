import { ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { useRef } from 'react';
import { Button } from '../components/Button';
import { GithubMark } from '../components/GithubMark';
import { useLoopActive } from '../lib/hooks';
import { EDITOR_URL, GITHUB_URL } from '../lib/links';
import { EditorMock } from './hero/EditorMock';
import './Hero.css';

const EASE = [0.16, 1, 0.3, 1] as const;

const HEADLINE = [
  { text: 'Edit', em: false },
  { text: 'video', em: false },
  { text: 'in', em: true },
  { text: 'tandem.', em: true },
];

const FACTS = ['Free forever', 'Open source', 'No install', 'No account'];

const rise = (delay: number) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.9, delay, ease: EASE },
});

export function Hero() {
  const reduced = useReducedMotion();
  const section = useRef<HTMLElement>(null);
  const active = useLoopActive(section);

  // The editor starts tipped back in perspective and settles flat as you scroll into it.
  const { scrollY } = useScroll();
  const settle = useSpring(useTransform(scrollY, [0, 560], [0, 1], { clamp: true }), {
    stiffness: 140,
    damping: 26,
    mass: 0.4,
  });
  const rotateX = useTransform(settle, [0, 1], [reduced ? 0 : 13, 0]);
  const scale = useTransform(settle, [0, 1], [reduced ? 1 : 0.955, 1]);
  const glow = useTransform(settle, [0, 1], [0.75, 1]);

  return (
    <section className="hero" id="top" aria-labelledby="hero-title" ref={section} data-active={active}>
      <div className="hero__backdrop" aria-hidden="true">
        <div className="hero__grid" />
        <div className="hero__aurora hero__aurora--violet" />
        <div className="hero__aurora hero__aurora--lime" />
        <div className="grain" />
      </div>

      <div className="container hero__inner">
        <motion.a
          className="hero__pill"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer noopener"
          {...rise(0)}
        >
          <span className="hero__pill-tag">MIT</span>
          Open source, start to finish
          <ArrowUpRight size="1em" strokeWidth={2.2} aria-hidden="true" />
        </motion.a>

        <h1 className="hero__title" id="hero-title" aria-label="Edit video in tandem.">
          {HEADLINE.map((word, i) => (
            <motion.span
              key={word.text}
              className={word.em ? 'hero__word hero__word--em' : 'hero__word'}
              aria-hidden="true"
              initial={{ opacity: 0, y: '0.35em', filter: 'blur(12px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 1.1, delay: 0.08 + i * 0.09, ease: EASE }}
            >
              {word.text}
            </motion.span>
          ))}
        </h1>

        <motion.p className="hero__sub" {...rise(0.42)}>
          Tandem is a free, open-source video editor that runs in your browser. Cut, grade and export on one
          timeline, with everyone on it at the same time.
        </motion.p>

        <motion.div className="hero__cta" {...rise(0.52)}>
          <Button href={EDITOR_URL} size="lg">
            Open the editor
            <ArrowRight className="btn__arrow" size="1.1em" strokeWidth={2.4} aria-hidden="true" />
          </Button>
          <Button href={GITHUB_URL} variant="ghost" size="lg" external>
            <GithubMark />
            Star on GitHub
          </Button>
        </motion.div>

        <motion.ul className="hero__facts" {...rise(0.62)}>
          {FACTS.map((fact) => (
            <li key={fact}>
              <Check size="0.95em" strokeWidth={3} aria-hidden="true" />
              {fact}
            </li>
          ))}
        </motion.ul>
      </div>

      <motion.div
        className="hero__stage"
        initial={{ opacity: 0, y: 60 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.4, delay: 0.5, ease: EASE }}
      >
        <motion.div className="hero__glow" style={{ opacity: glow }} aria-hidden="true" />
        <motion.div className="hero__window" style={{ rotateX, scale }}>
          <EditorMock />
        </motion.div>
      </motion.div>
    </section>
  );
}
