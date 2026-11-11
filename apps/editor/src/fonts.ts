/**
 * Bundled open-source typefaces for titles. Only the @font-face rules load up front; the browser
 * fetches a font file the first time it is actually used, and every collaborator renders the same
 * glyphs because nothing depends on locally installed fonts.
 */
import '@fontsource-variable/montserrat';
import '@fontsource-variable/oswald';
import '@fontsource-variable/playfair-display';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/caveat';
import '@fontsource/bebas-neue';
import '@fontsource/anton';
import '@fontsource/pacifico';
import '@fontsource/dm-serif-display';
import '@fontsource/permanent-marker';
import '@fontsource/archivo-black';

export interface FontChoice {
  /** CSS font-family name. */
  family: string;
  label: string;
  category: 'Sans' | 'Serif' | 'Display' | 'Script' | 'Mono';
  weights: number[];
}

export const FONTS: FontChoice[] = [
  { family: 'Inter Variable', label: 'Inter', category: 'Sans', weights: [300, 400, 500, 600, 700, 800, 900] },
  { family: 'Montserrat Variable', label: 'Montserrat', category: 'Sans', weights: [300, 400, 500, 600, 700, 800, 900] },
  { family: 'Space Grotesk Variable', label: 'Space Grotesk', category: 'Sans', weights: [300, 400, 500, 600, 700] },
  { family: 'Oswald Variable', label: 'Oswald', category: 'Display', weights: [300, 400, 500, 600, 700] },
  { family: 'Bebas Neue', label: 'Bebas Neue', category: 'Display', weights: [400] },
  { family: 'Anton', label: 'Anton', category: 'Display', weights: [400] },
  { family: 'Archivo Black', label: 'Archivo Black', category: 'Display', weights: [400] },
  { family: 'Playfair Display Variable', label: 'Playfair Display', category: 'Serif', weights: [400, 500, 600, 700, 800, 900] },
  { family: 'DM Serif Display', label: 'DM Serif Display', category: 'Serif', weights: [400] },
  { family: 'Caveat Variable', label: 'Caveat', category: 'Script', weights: [400, 500, 600, 700] },
  { family: 'Pacifico', label: 'Pacifico', category: 'Script', weights: [400] },
  { family: 'Permanent Marker', label: 'Permanent Marker', category: 'Script', weights: [400] },
  { family: 'JetBrains Mono Variable', label: 'JetBrains Mono', category: 'Mono', weights: [400, 500, 700, 800] },
];

export const fontByFamily = (family: string): FontChoice | undefined =>
  FONTS.find((f) => f.family === family || f.label === family);
