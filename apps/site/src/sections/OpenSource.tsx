import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { useInView } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from '../components/Button';
import { GithubMark } from '../components/GithubMark';
import { Reveal } from '../components/Reveal';
import { GITHUB_URL, LICENSE_URL } from '../lib/links';
import './OpenSource.css';

/** One step per line, each short enough to be read in full beside the copy at laptop widths. */
const COMMANDS = [`git clone ${GITHUB_URL}`, 'cd co-video', 'pnpm install && pnpm build && pnpm start'];

const STACK = [
  { name: 'TypeScript', color: '#5aa2ff' },
  { name: 'React', color: '#22d3ee' },
  { name: 'WebGL2', color: '#c6f84f' },
  { name: 'WebCodecs', color: '#ff9f43' },
  { name: 'Yjs', color: '#8b7cff' },
];

const PROMISES = ['No accounts.', 'No watermarks.', 'No upsell.'];

/** The command with a soft break after each slash, so a URL that has to wrap does so between path segments. */
function breakable(command: string): ReactNode[] {
  return command.split(/(?<=\/)/).flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
}

function Terminal() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -15% 0px' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(COMMANDS.join('\n')).then(() => setCopied(true));
  };

  // Each line types itself in turn once the block scrolls into view.
  let delay = 0.3;
  return (
    <div className="term" ref={ref} data-typing={inView}>
      <div className="term__bar">
        <span className="term__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term__title">Self-host in three commands</span>
        <button type="button" className="term__copy" onClick={copy} aria-live="polite">
          {copied ? <Check size="0.9rem" aria-hidden="true" /> : <Copy size="0.9rem" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="term__body">
        {COMMANDS.map((command, i) => {
          const style = { '--chars': command.length, '--delay': `${delay}s` } as CSSProperties;
          delay += command.length * 0.022 + 0.45;
          return (
            <code key={command} className="term__line" style={style}>
              <span className="term__prompt" aria-hidden="true">
                $
              </span>
              <span className="term__typed">{breakable(command)}</span>
              {i === COMMANDS.length - 1 && <span className="term__caret" aria-hidden="true" />}
            </code>
          );
        })}
      </pre>
    </div>
  );
}

export function OpenSource() {
  return (
    <section className="section os" id="open-source" aria-labelledby="open-source-title">
      <div className="container">
        <Reveal as="p" className="eyebrow" y={12}>
          <span className="eyebrow__marker" aria-hidden="true" />
          <span className="eyebrow__index" aria-hidden="true">
            06
          </span>
          Open source
        </Reveal>
        <h2 className="os__promises" id="open-source-title">
          {PROMISES.map((line, i) => (
            <Reveal as="span" key={line} delay={0.1 * i} y={36}>
              {line}
            </Reveal>
          ))}
        </h2>

        <div className="os__grid">
          <div className="os__copy">
            <Reveal as="p" className="lead">
              Tandem is MIT licensed and free, with nothing held back for a paid tier. Read the code, fork it,
              or run it on your own machine for your own team.
            </Reveal>
            <Reveal delay={0.06} className="os__actions">
              <Button href={GITHUB_URL} variant="ghost" size="lg" external>
                <GithubMark />
                Star on GitHub
              </Button>
              <a className="link" href={LICENSE_URL} target="_blank" rel="noreferrer noopener">
                Read the licence
                <ArrowUpRight size="1em" aria-hidden="true" />
              </a>
            </Reveal>
            <Reveal delay={0.12}>
              <ul className="os__stack" aria-label="Built with">
                {STACK.map((item) => (
                  <li key={item.name} style={{ '--dot': item.color } as CSSProperties}>
                    {item.name}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>

          <Reveal className="os__side" delay={0.1}>
            <Terminal />
            <p className="os__note">
              That starts one small Node server, which serves the editor, relays edits and keeps the media of
              the projects made on it. Your footage stays on your machine and on the server you run.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
