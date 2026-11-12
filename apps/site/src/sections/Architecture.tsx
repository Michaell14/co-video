import { Clapperboard, Cpu, FileVideo, FolderOpen, Network, PackageCheck, Server } from 'lucide-react';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '../components/Avatar';
import { Reveal } from '../components/Reveal';
import { SectionHead } from '../components/SectionHead';
import { useLoopActive } from '../lib/hooks';
import './Architecture.css';

/**
 * A connector between two nodes: dashes that flow in the direction of travel. It runs
 * left-to-right on wide screens and top-to-bottom when the diagram stacks. A `shared` wire is
 * what a shared project puts on the network: edits flowing both ways, and a heavier lane of media.
 */
function Wire({ kind = 'pixels' }: { kind?: 'pixels' | 'shared' }) {
  return (
    <li className={`wire wire--${kind}`} aria-hidden="true">
      <span className="wire__lane" />
      {kind === 'shared' && (
        <>
          <span className="wire__lane wire__lane--back" />
          <span className="wire__lane wire__lane--media" />
        </>
      )}
    </li>
  );
}

interface NodeProps {
  icon: ReactNode;
  title: string;
  detail: string;
  tone?: 'plain' | 'core' | 'edits';
  children?: ReactNode;
}

function Node({ icon, title, detail, tone = 'plain', children }: NodeProps) {
  return (
    <li className={`node node--${tone}`}>
      <span className="node__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="node__title">{title}</span>
      <span className="node__detail">{detail}</span>
      {children}
    </li>
  );
}

const NOTES = [
  {
    title: 'Nothing to wait for',
    text: 'Media is read from your disk and decoded by WebCodecs, on hardware decoders where your browser has them. There is no upload or transcode to sit through before you can cut.',
  },
  {
    title: 'Export is local too',
    text: 'The same compositor that draws the viewer feeds the encoder. Which codecs you can export depends on your browser.',
  },
  {
    title: 'A server with two small jobs',
    text: 'The server relays a project’s Yjs updates and stores its originals, so whoever you send a link to can stream them straight away. It never decodes or renders a frame. A project made with no server in reach stays on your device until you publish it.',
  },
];

export function Architecture() {
  const ref = useRef<HTMLElement>(null);
  const active = useLoopActive(ref);

  return (
    <section
      className="section"
      id="architecture"
      aria-labelledby="architecture-title"
      ref={ref}
      data-active={active}
    >
      <div className="container">
        <SectionHead
          index="05"
          eyebrow="How it works"
          id="architecture-title"
          title={
            <>
              Your GPU does the work. The server <em>renders nothing.</em>
            </>
          }
          lead="There is no render farm behind Tandem. Decoding, compositing and encoding all happen in your tab, on your hardware. A small server relays the edits and keeps a project’s media, so that a link is all a collaborator needs. Run the editor without one and everything stays on your device."
        />

        <Reveal>
          <div className="arch" role="group" aria-label="Diagram of Tandem’s architecture">
            <div className="arch__tab">
              <p className="arch__legend">
                <span className="arch__dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                Your browser tab
                <span className="arch__tag arch__tag--pixels">rendered locally</span>
              </p>
              <ol className="pipe" aria-label="Picture pipeline, in order">
                {/* \u00a0 ties each separator dot to the item before it, so no wrapped line starts with one. */}
                <Node icon={<FolderOpen size="1.1rem" />} title="Your media" detail="Read from your disk" />
                <Wire />
                <Node
                  icon={<Clapperboard size="1.1rem" />}
                  title="WebCodecs decode"
                  detail="Frames straight to the GPU"
                />
                <Wire />
                <Node
                  icon={<Cpu size="1.1rem" />}
                  title="WebGL2 compositor"
                  detail={'16-bit float\u00a0· layers, effects, grade'}
                  tone="core"
                />
                <Wire />
                <Node
                  icon={<PackageCheck size="1.1rem" />}
                  title="WebCodecs encode"
                  detail={'H.264\u00a0· HEVC\u00a0· VP9\u00a0· AV1'}
                />
                <Wire />
                <Node
                  icon={<FileVideo size="1.1rem" />}
                  title="Your file"
                  detail={'MP4\u00a0· MOV\u00a0· WebM\u00a0· MKV'}
                />
              </ol>
            </div>

            <div className="arch__net">
              <p className="arch__legend">
                Through the server
                <span className="arch__tags">
                  <span className="arch__tag arch__tag--edits">edits</span>
                  <span className="arch__tag arch__tag--media">media</span>
                </span>
              </p>
              <ol className="sync" aria-label="What goes through the server, in order">
                <Node
                  icon={<Network size="1.1rem" />}
                  title="Project and media"
                  detail="The edit as a Yjs document, and the originals it uses"
                  tone="edits"
                />
                <Wire kind="shared" />
                <Node
                  icon={<Server size="1.1rem" />}
                  title="Tandem server"
                  detail="One small Node process. Relays edits, stores the media"
                  tone="edits"
                />
                <Wire kind="shared" />
                <Node
                  icon={null}
                  title="Everyone else"
                  detail="Streams the media; decodes and composites in their own tab"
                  tone="edits"
                >
                  <span className="node__people" aria-hidden="true">
                    <Avatar name="Maya" color="#ff5d5d" size="1.5rem" />
                    <Avatar name="Jonas" color="#22d3ee" size="1.5rem" />
                    <Avatar name="Aiko" color="#ff9f43" size="1.5rem" />
                  </span>
                </Node>
              </ol>
            </div>
          </div>
        </Reveal>

        <ul className="arch-notes">
          {NOTES.map((note, i) => (
            <Reveal as="li" key={note.title} delay={0.06 * i}>
              <h3 className="h3">{note.title}</h3>
              <p>{note.text}</p>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
