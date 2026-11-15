/** What a text field holds at one moment: its text, and where the caret or the selection is. */
export interface TextState {
  text: string;
  start: number;
  end: number;
}

/** The kinds of input that go on from where the last one left the caret: typing and erasing. */
const RUNS = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);

/**
 * Undo and redo for one stretch of typing into a title.
 *
 * The browser's own would do if it stayed in the field. Chromium keeps one history for every
 * field of a page: at the end of this field's, the same key goes on to take back what was typed
 * into another one and moves the keyboard there. Typing into a title must end with the title, so
 * its steps are kept here: a run of typing or of erasing is one step, and it ends where a word
 * does, where the caret was moved, or where something else was done. Whatever else is noted (a
 * paste, a line break, what an input method composed) is a step by itself.
 */
export class TypingHistory {
  private readonly past: TextState[] = [];
  private readonly future: TextState[] = [];
  private kind: string | null = null;

  constructor(private now: TextState) {}

  /**
   * Note a change the field has made: what it held `before`, what it holds `after`, and the kind
   * of input that did it (an `InputEvent.inputType`).
   */
  record(before: TextState, after: TextState, kind: string): void {
    const onward =
      RUNS.has(kind) &&
      kind === this.kind &&
      before.text === this.now.text &&
      before.start === this.now.start &&
      before.end === this.now.end &&
      !this.beginsWord(before, after);
    if (!onward) this.past.push(before);
    this.future.length = 0;
    this.kind = kind;
    this.now = after;
  }

  /** Whether what was typed starts a new word: white space after a letter, or a letter after it. */
  private beginsWord(before: TextState, after: TextState): boolean {
    const typed = after.text.slice(before.start, after.end);
    const last = before.text.slice(0, before.start).slice(-1);
    if (!typed || !last || after.text.length <= before.text.length) return false;
    return /\s/.test(typed) !== /\s/.test(last);
  }

  /**
   * The field was set from outside (someone else changed the title): what was typed before no
   * longer leads here, so there is nothing left to take back.
   */
  reset(now: TextState): void {
    this.past.length = 0;
    this.future.length = 0;
    this.kind = null;
    this.now = now;
  }

  /** The state to put the field back into, or null when nothing is left to undo. */
  undo(): TextState | null {
    const back = this.past.pop();
    if (!back) return null;
    this.future.push(this.now);
    this.kind = null;
    this.now = back;
    return back;
  }

  /** The state an undone step led to, or null when nothing was undone. */
  redo(): TextState | null {
    const again = this.future.pop();
    if (!again) return null;
    this.past.push(this.now);
    this.kind = null;
    this.now = again;
    return again;
  }
}
