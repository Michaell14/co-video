import { useEffect } from 'react';
import { Architecture } from './Architecture';
import { Color } from './Color';
import { Compare } from './Compare';
import { Editing } from './Editing';
import { Effects } from './Effects';
import { FinalCta } from './FinalCta';
import { Multiplayer } from './Multiplayer';
import { OpenSource } from './OpenSource';
import { Stats } from './Stats';

interface BelowFoldProps {
  /** Called once these sections are in the document. */
  onReady: () => void;
}

/**
 * Everything after the hero. Loaded as its own chunk once the hero is interactive, so the first
 * paint only pays for what is on screen.
 */
export default function BelowFold({ onReady }: BelowFoldProps) {
  useEffect(() => {
    onReady();
    // A deep link (/#color) could not be honoured before its target existed. Honour it now.
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [onReady]);

  return (
    <>
      <Stats />
      <Multiplayer />
      <Editing />
      <Effects />
      <Color />
      <Architecture />
      <OpenSource />
      <Compare />
      <FinalCta />
    </>
  );
}
