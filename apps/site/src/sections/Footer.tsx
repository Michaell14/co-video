import { Logo } from '../components/Logo';
import { EDITOR_URL, GITHUB_URL, ISSUES_URL, LICENSE_URL } from '../lib/links';
import { FEATURE_SECTIONS, OPEN_SOURCE_SECTION } from '../lib/sections';
import './Footer.css';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Open the editor', href: EDITOR_URL },
      ...FEATURE_SECTIONS.map((section) => ({ label: section.label, href: `#${section.id}` })),
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'Source on GitHub', href: GITHUB_URL, external: true },
      { label: 'Report an issue', href: ISSUES_URL, external: true },
      { label: 'MIT licence', href: LICENSE_URL, external: true },
      { label: 'Self-hosting', href: `#${OPEN_SOURCE_SECTION.id}` },
      { label: 'How it works', href: '#architecture' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__brand">
          <a href="#top" aria-label="Tandem, back to top">
            <Logo />
          </a>
          <p>The open-source multiplayer video editor. Runs in a browser tab, on your hardware.</p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title} className="footer__col">
            <h2 className="footer__heading">{column.title}</h2>
            <ul>
              {column.links.map((link) => (
                <li key={link.label}>
                  <a
                    className="link"
                    href={link.href}
                    {...('external' in link ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="container footer__base">
        <p>MIT licensed. © {new Date().getFullYear()} the Tandem contributors.</p>
        <p className="footer__made">
          <span className="footer__pulse" aria-hidden="true" />
          Made in the open.
        </p>
      </div>
    </footer>
  );
}
