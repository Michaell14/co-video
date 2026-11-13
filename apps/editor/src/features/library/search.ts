/** Finding effects and transitions by what someone types. */

/**
 * Text as it is compared in a search, with the spellings that differ between British and American
 * English written one way. The names here are British (Colour Overlay, Posterise, Centre), and
 * someone who types `color`, `posterize` or `center` is looking for the same things. Both sides of
 * a comparison are folded, so it does not matter that the odd other word is caught as well.
 */
export const foldSpelling = (text: string): string =>
  text
    .replace(/colour/g, 'color')
    .replace(/centre/g, 'center')
    .replace(/grey/g, 'gray')
    .replace(/is(e|ing|ation)/g, 'iz$1');

/**
 * The items whose name or description holds the query, as typed or in either spelling. The text
 * as typed is tried too: half a word (`colou`) is not yet a spelling to fold, and still finds.
 */
export function search<T extends { name: string; description: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const folded = foldSpelling(q);
  const holds = (text: string): boolean => {
    const t = text.toLowerCase();
    return t.includes(q) || foldSpelling(t).includes(folded);
  };
  return items.filter((i) => holds(i.name) || holds(i.description));
}
