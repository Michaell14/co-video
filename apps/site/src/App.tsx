import { MotionConfig } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Footer } from './sections/Footer';
import { Hero } from './sections/Hero';
import { Nav } from './sections/Nav';

const BelowFold = lazy(() => import('./sections/BelowFold'));

/** True once the browser has had an idle moment, or sooner if the visitor scrolls or deep-links. */
function useDeferredMount(): boolean {
  const [mounted, setMounted] = useState(() => window.location.hash.length > 1);
  useEffect(() => {
    if (mounted) return;
    const mount = () => setMounted(true);
    const hasIdle = 'requestIdleCallback' in window;
    const handle = hasIdle
      ? window.requestIdleCallback(mount, { timeout: 1200 })
      : window.setTimeout(mount, 300);
    window.addEventListener('scroll', mount, { once: true, passive: true });
    return () => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      window.removeEventListener('scroll', mount);
    };
  }, [mounted]);
  return mounted;
}

export function App() {
  const mountRest = useDeferredMount();
  const [sectionsReady, setSectionsReady] = useState(false);
  const onReady = useCallback(() => setSectionsReady(true), []);

  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Nav sectionsReady={sectionsReady} />
      <main id="main">
        <Hero />
        {mountRest && (
          <Suspense fallback={null}>
            <BelowFold onReady={onReady} />
          </Suspense>
        )}
      </main>
      {sectionsReady && <Footer />}
    </MotionConfig>
  );
}
