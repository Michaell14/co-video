import { Check, Minus } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SectionHead } from '../components/SectionHead';
import './Compare.css';

/** `true` = yes, `false` = no, a string = a qualified answer shown as text. */
type Answer = boolean | string;

interface Row {
  feature: string;
  note?: string;
  tandem: Answer;
  desktop: Answer;
  web: Answer;
}

const ROWS: Row[] = [
  { feature: 'Real-time co-editing', tandem: true, desktop: 'varies', web: 'varies' },
  { feature: 'Runs in the browser', tandem: true, desktop: false, web: true },
  { feature: 'Nothing to install', tandem: true, desktop: false, web: true },
  { feature: 'Free and open source', tandem: true, desktop: 'varies', web: 'rarely' },
  { feature: 'Self-hostable', tandem: true, desktop: 'runs locally', web: 'rarely' },
  { feature: 'Float colour pipeline with scopes', tandem: true, desktop: true, web: 'rarely' },
  {
    feature: 'HDR export',
    note: 'In Tandem, where the browser can encode it',
    tandem: true,
    desktop: true,
    web: 'rarely',
  },
  { feature: 'Keeps working offline', tandem: true, desktop: true, web: 'varies' },
  { feature: 'Export without uploading your footage', tandem: true, desktop: true, web: 'varies' },
  { feature: 'Native plug-ins (OFX, VST) and camera RAW', tandem: false, desktop: true, web: false },
];

function Cell({ answer, own }: { answer: Answer; own?: boolean }) {
  if (answer === true) {
    return (
      <>
        <Check
          className={own ? 'cmp__yes cmp__yes--own' : 'cmp__yes'}
          size="1.15rem"
          strokeWidth={2.6}
          aria-hidden="true"
        />
        <span className="sr-only">Yes</span>
      </>
    );
  }
  if (answer === false) {
    return (
      <>
        <Minus className="cmp__no" size="1.15rem" strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">No</span>
      </>
    );
  }
  return <span className="cmp__text">{answer}</span>;
}

export function Compare() {
  return (
    <section className="section section--tint" id="compare" aria-labelledby="compare-title">
      <div className="container">
        <SectionHead
          index="07"
          eyebrow="Where it fits"
          id="compare-title"
          title={
            <>
              An honest <em>side-by-side.</em>
            </>
          }
          lead="Desktop editors are deep and mature. Web editors are convenient. Tandem is trying to be both, and it does not win every row."
        />

        <Reveal>
          <div className="cmp">
            <table className="cmp__table">
              <caption className="sr-only">
                Feature comparison between Tandem, a typical desktop non-linear editor and a typical web-based
                editor
              </caption>
              <thead>
                <tr>
                  <td />
                  <th scope="col" className="cmp__own">
                    Tandem
                  </th>
                  <th scope="col">
                    <span className="cmp__wide">Typical desktop NLE</span>
                    <span className="cmp__narrow">Desktop NLE</span>
                  </th>
                  <th scope="col">
                    <span className="cmp__wide">Typical web editor</span>
                    <span className="cmp__narrow">Web editor</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row">
                      {row.feature}
                      {row.note && <span className="cmp__note">{row.note}</span>}
                    </th>
                    <td className="cmp__own">
                      <Cell answer={row.tandem} own />
                    </td>
                    <td>
                      <Cell answer={row.desktop} />
                    </td>
                    <td>
                      <Cell answer={row.web} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
        <Reveal as="p" className="cmp__foot">
          “Typical” is a generalisation: individual products differ, and several desktop editors are both
          excellent and free. Check the one you use.
        </Reveal>
      </div>
    </section>
  );
}
