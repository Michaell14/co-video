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
 * left-to-right on wide screens and top-to-bottom when the diagram stacks. `both` draws a second
 * lane flowing the other way.
 */
function Wire({ kind = 'pixels', both = false }: { kind?: 'pixels' | 'edits'; both?: boolean }) {
  return (
    <li className={`wire wire--${kind}`} aria-hidden="true">
      <span className="wire__lane" />
      {both && <span className="wire__lane wire__lane--back" />}
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
    title: 'No upload, no queue',
    text: 'Media is read from disk and decoded by WebCodecs, on hardware decoders where your browser has them. There is nothing to wait for.',
  },
  {
    title: 'Export is local too',
    text: 'The same compositor that draws the viewer feeds the encoder. Which codecs you can export depends on your browser.',
  },
  {
    title: 'A server with one job',
    text: 'It passes Yjs updates between tabs over a WebSocket. An edit is a handful of bytes; your footage never goes through it.',
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
              Your GPU does the work. Our server <em>only relays edits.</em>
            </>
          }
          lead="There is no render farm behind Tandem. Decoding, compositing and encoding all happen in your tab, on your hardware. The only thing that travels is the edit itself."
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
                <span className="arch__tag arch__tag--pixels">pixels stay here</span>
              </p>
              <ol className="pipe" aria-label="Picture pipeline, in order">
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
                  detail="16-bit float · layers, effects, grade"
                  tone="core"
                />
                <Wire />
                <Node
                  icon={<PackageCheck size="1.1rem" />}
                  title="WebCodecs encode"
                  detail="H.264 · HEVC · VP9 · AV1"
                />
                <Wire />
                <Node icon={<FileVideo size="1.1rem" />} title="Your file" detail="MP4 · MOV · WebM · MKV" />
              </ol>
            </div>

            <div className="arch__net">
              <p className="arch__legend">
                Between tabs
                <span className="arch__tag arch__tag--edits">edits only</span>
              </p>
              <ol className="sync" aria-label="Collaboration path, in order">
                <Node
                  icon={<Network size="1.1rem" />}
                  title="Yjs document"
                  detail="The project, as a CRDT. Lives in your tab."
                  tone="edits"
                />
                <Wire kind="edits" both />
                <Node
                  icon={<Server size="1.1rem" />}
                  title="Relay server"
                  detail="One small Node process, passing updates along"
                  tone="edits"
                />
                <Wire kind="edits" both />
                <Node
                  icon={null}
                  title="Everyone else"
                  detail="Each tab does its own decoding and compositing"
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
