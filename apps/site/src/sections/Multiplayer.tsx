import { GitMerge, History, KeyRound, WifiOff } from 'lucide-react';
import { GlowCard } from '../components/GlowCard';
import { Reveal } from '../components/Reveal';
import { SectionHead } from '../components/SectionHead';
import { MultiplayerDemo } from './multiplayer/MultiplayerDemo';
import './Multiplayer.css';

const POINTS = [
  {
    icon: GitMerge,
    title: 'No locks, no “file in use”',
    body: 'The project is a Yjs CRDT. Two people can trim the same clip in the same second and every copy converges on the same edit.',
  },
  {
    icon: WifiOff,
    title: 'Offline is a normal state',
    body: 'Lose the connection and keep cutting. Your changes are stored locally and merge when you are back.',
  },
  {
    icon: KeyRound,
    title: 'Roles on a link',
    body: 'Share a URL as editor, commenter or viewer. Nobody has to create an account to open it.',
  },
  {
    icon: History,
    title: 'Your undo is yours',
    body: 'Undo steps back through your own edits and leaves everyone else’s alone. Version history covers the rest.',
  },
];

const PRESENCE = [
  'Live cursors',
  'Live playheads',
  'Shared selections',
  'Follow mode',
  'Time-coded comments',
  'Per-user undo',
  'Version history',
];

export function Multiplayer() {
  return (
    <section className="section" id="multiplayer" aria-labelledby="multiplayer-title">
      <div className="container">
        <SectionHead
          index="01"
          eyebrow="Multiplayer"
          id="multiplayer-title"
          title={
            <>
              One timeline. <em>Everyone</em> on it.
            </>
          }
          lead="No review exports, no project file in a shared folder. Everyone opens the same project and works in it at once; cursors, playheads and selections update as they happen."
        />

        <Reveal>
          <figure className="mp-figure">
            <MultiplayerDemo />
            <figcaption className="mp-figure__caption">
              <span className="mp-figure__live">Live demo</span>
              You are the lime cursor. Drag the title or the audio clips, or follow Maya. The other two are
              scripted.
            </figcaption>
          </figure>
        </Reveal>

        <ul className="mp-points">
          {POINTS.map((point, i) => (
            <Reveal as="li" key={point.title} delay={0.06 * i}>
              <GlowCard className="mp-point">
                <point.icon className="mp-point__icon" size="1.375rem" strokeWidth={1.7} aria-hidden="true" />
                <h3 className="h3">{point.title}</h3>
                <p>{point.body}</p>
              </GlowCard>
            </Reveal>
          ))}
        </ul>

        <Reveal>
          <ul className="chips mp-presence" aria-label="Presence features">
            {PRESENCE.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
