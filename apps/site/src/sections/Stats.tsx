import { CountUp } from '../components/CountUp';
import { Reveal } from '../components/Reveal';
import './Stats.css';

const STATS = [
  { to: 8, unit: 'K', label: 'Resolution-independent projects, all the way up to 8K.' },
  { to: 240, unit: 'fps', label: 'Timelines from 24p film to 240 fps slow motion.' },
  { to: 16, unit: '-bit float', label: 'One float colour pipeline from decode to export.' },
  { to: 0, from: 14, unit: 'installs', label: 'No download, no plug-in, no account. Open a URL.' },
];

export function Stats() {
  return (
    <section className="stats" aria-labelledby="stats-title">
      <div className="container stats__inner">
        <Reveal className="stats__head">
          <h2 className="stats__title" id="stats-title">
            Runs in a tab.
          </h2>
          <p className="stats__lead">
            WebCodecs decodes and encodes. WebGL2 composites. The machine you already own does the rest.
          </p>
        </Reveal>
        <dl className="stats__grid">
          {STATS.map((stat, i) => (
            <Reveal key={stat.unit} className="stats__item" delay={0.06 * i}>
              <dt className="stats__label">{stat.label}</dt>
              <dd className="stats__value">
                <CountUp to={stat.to} from={stat.from} />
                <span className="stats__unit">{stat.unit}</span>
              </dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
