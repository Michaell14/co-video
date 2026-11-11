/**
 * The nav and the footer name the page's sections from one list (src/lib/sections.ts). That list
 * is only right while it matches the page: every entry has to be the id of a section that is
 * rendered, in the order the sections are rendered (or the nav's active marker would jump
 * backwards while the visitor scrolls down), under the name the section's own eyebrow uses.
 *
 * This reads the sources, so moving a section in BelowFold, renaming its id or retitling it
 * without updating the list fails here instead of on the live page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEATURE_SECTIONS, OPEN_SOURCE_SECTION } from '../src/lib/sections';

const sectionsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/sections');
const read = (name: string): string => readFileSync(join(sectionsDir, name), 'utf8');

interface RenderedSection {
  component: string;
  /** The `id` of the component's <section>, if it has one. */
  id: string | undefined;
  /** The `eyebrow` it passes to SectionHead, if it uses one. */
  eyebrow: string | undefined;
}

/** The sections below the hero, in the order BelowFold renders them. */
function renderedSections(): RenderedSection[] {
  const belowFold = read('BelowFold.tsx');
  const rendered = [...belowFold.matchAll(/^\s*<([A-Z]\w*) \/>$/gm)].map((match) => match[1]);
  return rendered.map((component) => {
    const file = new RegExp(`import \\{ ${component} \\} from '\\./(\\w+)'`).exec(belowFold)?.[1];
    if (!file) throw new Error(`BelowFold renders <${component} /> but does not import it by that name`);
    const source = read(`${file}.tsx`);
    return {
      component,
      id: /<section\b[^>]*?\sid="([^"]+)"/s.exec(source)?.[1],
      eyebrow: /\beyebrow="([^"]+)"/.exec(source)?.[1],
    };
  });
}

describe('section list shared by the nav and the footer', () => {
  const page = renderedSections();
  const listed = [...FEATURE_SECTIONS, OPEN_SOURCE_SECTION];

  it('finds the sections of the page', () => {
    expect(page.length).toBeGreaterThanOrEqual(listed.length);
    expect(page.filter((section) => section.id !== undefined).length).toBeGreaterThanOrEqual(listed.length);
  });

  it('only lists sections that exist, in page order', () => {
    const positions = listed.map((entry) => page.findIndex((section) => section.id === entry.id));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('calls each section what its eyebrow calls it', () => {
    for (const entry of listed) {
      const eyebrow = page.find((section) => section.id === entry.id)?.eyebrow;
      // Sections that build their own heading have no eyebrow prop to compare with.
      if (eyebrow === undefined) continue;
      expect(eyebrow.startsWith(entry.label), `"${entry.label}" vs eyebrow "${eyebrow}"`).toBe(true);
    }
  });
});
