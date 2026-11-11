/** SubRip (.srt) and WebVTT subtitle parsing / serialisation. */

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function parseTime(s: string): number | null {
  const m = TIME.exec(s.trim());
  if (!m) return null;
  if (m[1] !== undefined) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000;
  return +m[5] * 60 + +m[6] + +m[7].padEnd(3, '0') / 1000;
}

/** A timing line and nothing else: `start --> end`, optionally followed by WebVTT cue settings. */
const TIMING = new RegExp(`^\\s*(?:${TIME.source})\\s*-->\\s*(?:${TIME.source})(?:\\s.*)?$`);

/** Parses SRT or WebVTT. Unknown lines are skipped rather than failing the whole file. */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = [];
  let open: { start: number; end: number; lines: string[] } | null = null;
  const close = (): void => {
    if (!open) return;
    const body = open.lines
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .trim();
    if (body) cues.push({ start: open.start, end: open.end, text: body });
    open = null;
  };
  // Lines that precede a block's timing line (cue numbers, identifiers, the WEBVTT header) and
  // blocks without a usable one are skipped.
  let skipping = false;
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .split('\n');
  for (const line of lines) {
    // Editors leave spaces or tabs on the separator line; it still ends the cue.
    if (line.trim() === '') {
      close();
      skipping = false;
      continue;
    }
    if (skipping) continue;
    // Inside a cue only an unmistakable timing line starts the next one, for files that lost their
    // blank lines; an arrow in the text itself stays text.
    if (open ? TIMING.test(line) : line.includes('-->')) {
      if (open) {
        // The number above the new timing line is that cue's counter, not the last line of this one.
        if (/^\s*\d+\s*$/.test(open.lines[open.lines.length - 1] ?? '')) open.lines.pop();
        close();
      }
      const [a, b] = line.split('-->');
      const start = parseTime(a);
      const end = parseTime(b ?? '');
      if (start === null || end === null || end <= start) skipping = true;
      else open = { start, end, lines: [] };
    } else if (open) open.lines.push(line);
  }
  close();
  return cues.sort((x, y) => x.start - y.start);
}

function fmt(t: number, sep: string): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: Cue[]): string {
  return (
    'WEBVTT\n\n' + cues.map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}\n`).join('\n')
  );
}
