import { Menu, X } from 'lucide-react';
import { AnimatePresence, motion, useMotionValueEvent, useScroll, useSpring } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { GithubMark } from '../components/GithubMark';
import { Logo } from '../components/Logo';
import { EDITOR_URL, GITHUB_URL } from '../lib/links';
import { FEATURE_SECTIONS, OPEN_SOURCE_SECTION } from '../lib/sections';
import './Nav.css';

/** In page order, so the active marker only ever moves forward as the visitor scrolls down. */
const LINKS = [...FEATURE_SECTIONS, OPEN_SOURCE_SECTION];

/**
 * Which nav section currently sits under the top third of the viewport. Sections below the fold
 * mount a moment after first paint; `sectionsReady` flips then, and we start observing them.
 */
function useActiveSection(sectionsReady: boolean): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!sectionsReady) return;
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setActive(LINKS.find((link) => visible.has(link.id))?.id ?? null);
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    for (const link of LINKS) {
      const el = document.getElementById(link.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sectionsReady]);
  return active;
}

interface NavProps {
  /** True once the sections the links point at are in the document. */
  sectionsReady: boolean;
}

export function Nav({ sectionsReady }: NavProps) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const active = useActiveSection(sectionsReady);

  const { scrollY, scrollYProgress } = useScroll();
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 16));
  const progress = useSpring(scrollYProgress, { stiffness: 200, damping: 40, mass: 0.3 });

  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The menu takes whatever is focused inside it away with it. Hand that focus back to the
      // button that opened the menu, or it would be left on nothing at all.
      if (document.getElementById('nav-menu')?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="nav" data-scrolled={scrolled} data-open={open}>
      <div className="nav__bar">
        <a className="nav__brand" href="#top" aria-label="Tandem, back to top">
          <Logo />
        </a>

        <nav className="nav__links" aria-label="Sections">
          {LINKS.map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              className="nav__link"
              aria-current={active === link.id ? 'true' : undefined}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav__actions">
          <a
            className="nav__github"
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Tandem on GitHub"
          >
            <GithubMark size="1.25rem" />
          </a>
          <Button href={EDITOR_URL}>Open the editor</Button>
          <button
            ref={toggle}
            type="button"
            className="nav__toggle"
            aria-expanded={open}
            aria-controls="nav-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size="1.25rem" /> : <Menu size="1.25rem" />}
          </button>
        </div>
      </div>

      {/* Scroll position as a playhead running along the bottom edge of the bar. */}
      <motion.div className="nav__progress" style={{ scaleX: progress }} aria-hidden="true" />

      <AnimatePresence>
        {open && (
          <motion.nav
            id="nav-menu"
            className="nav__menu"
            aria-label="Sections"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {LINKS.map((link) => (
              <a key={link.id} href={`#${link.id}`} onClick={() => setOpen(false)}>
                {link.label}
              </a>
            ))}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" onClick={() => setOpen(false)}>
              GitHub
            </a>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
