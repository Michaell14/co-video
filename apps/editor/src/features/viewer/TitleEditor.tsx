import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { DEFAULT_TEXT, type ID } from '@tandem/core';
import { fontEpoch, fontStack, layerAtRest, layoutLayer, layoutText, onFontsLoaded } from '@tandem/engine';
import {
  useLiveProject,
  usePlayer,
  usePlayerState,
  useSession,
  useThrottledFrame,
} from '../../session/hooks';
import { cmd } from '../../state/commands';
import { eventKeys } from '../../state/keys';
import { beginGesture, patchClips } from '../../state/props';
import { isTyping } from '../../state/shortcuts';
import { useUI } from '../../state/ui';
import { toast } from '../../ui/core';
import { isTextEntry, layerOpen, spendKeys, usingKeyboard } from '../../ui/layers';
import { useCanEdit } from '../timeline/access';
import { selectedLayers } from './selectedLayers';
import { titleField } from './titleField';
import { TypingHistory, type TextState } from './typingHistory';

/**
 * Typing into a title where it stands in the picture.
 *
 * The picture goes on drawing the title, as it does for everyone else in the project: each change
 * is written to the project at once. Over the title lies a text field that shows none of its text,
 * only the caret and the selection, and is laid out by the measures the title was drawn by (see
 * `titleField`). So the letters under the caret are the rendered ones, with their stroke, shadow
 * and background, and nothing moves when the typing ends.
 *
 * The field's lines are broken by the browser and the title's by `wrapLines`, which follows the
 * browser's rules for what titles are written in: words, numbers, punctuation, hyphens and
 * dashes. Where the two still part at the edge of a title's box (an emoji set against a word, a
 * script written without spaces), the caret is drawn a line off from there on. The text and the
 * picture are right all the same.
 */
export function TitleEditor({ scale }: { scale: number }) {
  const session = useSession();
  const typing = useUI((s) => s.typing);

  // A title is typed into in the project it belongs to: nothing of it is taken along to the next.
  useEffect(() => () => useUI.getState().set({ typing: null }), [session]);

  // Enter or F2 on the one title that is selected starts typing, with its text selected. F2 does
  // so wherever the keyboard is. Enter is the key of whatever control has the keyboard, so it only
  // counts where none has it, or a clip on the timeline that a press left it on. (A clip the
  // keyboard walked to takes Enter itself, to select.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = eventKeys(e);
      if ((keys !== 'enter' && keys !== 'f2') || e.defaultPrevented || e.repeat || e.isComposing) return;
      const { selection, workspace, dialog } = useUI.getState();
      if (isTyping(e.target) || dialog || layerOpen() || workspace !== 'edit' || !session.canEdit) return;
      const on = e.target as HTMLElement | null;
      if (keys === 'enter' && on !== document.body && !on?.dataset?.clip) return;
      const clip = selection.length === 1 ? session.store.get().clips[selection[0]] : undefined;
      if (clip?.type !== 'text') return;
      e.preventDefault();
      e.stopPropagation();
      cmd.editText(clip.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session]);

  return typing ? <TitleInput key={typing.clip} clipId={typing.clip} at={typing.at} scale={scale} /> : null;
}

const read = (el: HTMLTextAreaElement): TextState => ({
  text: el.value,
  start: el.selectionStart,
  end: el.selectionEnd,
});

/** Where a position in `before` lies once the text has become `after`: what is around it stays around it. */
function carried(before: string, after: string, position: number): number {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  const most = Math.min(before.length, after.length) - head;
  while (tail < most && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  if (position <= head) return position;
  if (position >= before.length - tail) return position + after.length - before.length;
  return after.length - tail;
}

function TitleInput({
  clipId,
  at,
  scale,
}: {
  clipId: ID;
  at: { x: number; y: number } | null;
  scale: number;
}) {
  const session = useSession();
  const editable = useCanEdit();
  const player = usePlayer();
  const playing = usePlayerState().playing;
  const project = useLiveProject((p) => p);
  const frame = useThrottledFrame(12);
  // The title is laid out with the fonts that have arrived so far: again when one lands.
  const fonts = useSyncExternalStore(onFontsLoaded, fontEpoch);
  const elsewhere = useUI(
    (s) => s.workspace !== 'edit' || !!s.sourceAsset || s.selection.length !== 1 || s.selection[0] !== clipId,
  );
  const ref = useRef<HTMLTextAreaElement>(null);
  const history = useRef<TypingHistory | null>(null);
  const before = useRef<TextState | null>(null);
  /** What the field held when the input method began to compose what it is composing. */
  const composed = useRef<TextState | null>(null);
  /** The control the keyboard came from, when it was the keyboard that asked for the title. */
  const origin = useRef<HTMLElement | null>(null);
  const { width: W, height: H } = project.settings;

  const clip = project.clips[clipId];
  const text = clip?.type === 'text' ? clip.text : null;
  /** What the title said when the typing began. */
  const [said] = useState(() => text?.content ?? '');
  const locked = !!clip && !!project.tracks[clip.trackId]?.locked;
  const layer = useMemo(() => selectedLayers(project, frame, [clipId])[0] ?? null, [project, frame, clipId]);
  const field = useMemo(() => {
    if (!text || !layer) return null;
    const layout = layoutText(text, W, H);
    const box = layoutLayer(layerAtRest(layer), layout.width, layout.height, W, H, 1);
    return titleField(box, layout, scale);
  }, [text, layer, W, H, scale, fonts]);

  // Why the typing cannot go on, if it cannot. `quiet` is what the person did themselves.
  const over = !text
    ? 'removed'
    : !editable
      ? 'access'
      : locked
        ? 'locked'
        : playing || elsewhere
          ? 'quiet'
          : !layer
            ? 'away'
            : null;

  const end = () => {
    if (useUI.getState().typing?.clip === clipId) useUI.getState().set({ typing: null });
  };

  useEffect(() => {
    if (!over) return;
    end();
    if (over === 'removed') toast('This title was removed.', 'info');
    else if (over === 'away') toast('This title is no longer shown at the playhead.', 'info');
    // Asking again is refused, in the words every such request is refused in.
    else if (over !== 'quiet') cmd.editText(clipId);
  }, [over]);

  // The title holds still while it is typed into, all of its text in place: the animation it
  // comes and goes with is back when the typing ends. The compositor is another one once the
  // graphics context has been lost and restored.
  const watch = useCallback((fn: () => void) => player?.subscribe(fn) ?? (() => {}), [player]);
  const lost = useSyncExternalStore(watch, () => player?.contextLost ?? false);
  useEffect(() => {
    if (!player) return;
    const { compositor } = player;
    compositor.atRest = clipId;
    player.invalidate();
    return () => {
      compositor.atRest = null;
      player.invalidate();
    };
  }, [player, clipId, lost]);

  const shown = !!field && !over;

  // The keyboard goes into the title as the field appears: the caret where the pointer asked for
  // it, or all of the text selected, to be typed over.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (active !== el && usingKeyboard() && active instanceof HTMLElement && !isTextEntry(active)) {
      origin.current = active === document.body ? null : active;
    }
    // All of the typing is one step of the project's history, begun here.
    beginGesture();
    // The key that asked for the title has done its work: held down, it types nothing into it.
    spendKeys();
    el.focus({ preventScroll: true });
    const caret = at && document.caretPositionFromPoint?.(at.x, at.y);
    if (caret && caret.offsetNode === el) el.setSelectionRange(caret.offset, caret.offset);
    else if (at) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
    history.current = new TypingHistory(read(el));
  }, [shown, at]);

  // The typing is over once the field has left the page. Only then: a development build runs the
  // effects of a component twice as it mounts, with the field still in place in between.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (!el || el.isConnected) return;
      const now = session.store.get().clips[clipId];
      if (now?.type === 'text' && !now.text?.content.trim() && said.trim() && session.canEdit) {
        // An empty title would stay on the timeline and show nothing. The inspector's field takes
        // no clip away either, so the title says again what it said before.
        patchClips([clipId], (c) => ({ text: { ...(c.text ?? DEFAULT_TEXT), content: said } }), true);
        if (session.store.get().clips[clipId]?.text?.content === said) {
          toast('The title was left empty: its text from before was put back.', 'info');
        }
      }
      // Whatever is done next is a step of its own.
      beginGesture();
    };
  }, [shown, session, clipId, said]);

  const write = (state: TextState) => {
    patchClips([clipId], (c) => ({ text: { ...(c.text ?? DEFAULT_TEXT), content: state.text } }), true);
  };

  /** Put the field into a state of its history, and the title with it. */
  const restore = (state: TextState | null | undefined) => {
    const el = ref.current;
    if (!el || !state) return;
    el.value = state.text;
    el.setSelectionRange(state.start, state.end);
    write(state);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (e: InputEvent) => {
      // The browser's own history is not the field's alone (see `TypingHistory`).
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        restore(e.inputType === 'historyUndo' ? history.current?.undo() : history.current?.redo());
      } else before.current = read(el);
    };
    const onInput = (e: Event) => {
      const after = read(el);
      // What an input method composes is one step, noted when it is done (see `settle`).
      if (!composed.current) {
        history.current?.record(before.current ?? after, after, (e as InputEvent).inputType ?? '');
      }
      before.current = null;
      write(after);
    };
    // A press anywhere else ends the typing, whether or not it takes the keyboard away.
    const onPress = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) end();
    };
    // To show the caret a browser scrolls whatever it takes: the field, whose text has to stay on
    // the title's, and the viewer around it, which nobody could scroll back afterwards. Neither
    // moves. A viewer that does scroll, because the picture is larger than it, follows the caret.
    const onScroll = (e: Event) => {
      const box = e.target;
      if (!(box instanceof HTMLElement) || !box.contains(el)) return;
      const { overflowX, overflowY } = getComputedStyle(box);
      if (overflowX === 'hidden' || overflowX === 'clip') box.scrollLeft = 0;
      if (overflowY === 'hidden' || overflowY === 'clip') box.scrollTop = 0;
    };
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('input', onInput);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('input', onInput);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onPress, true);
    };
  });

  // The text changed without having been typed here (someone else is in the same title): the
  // field follows, and the caret stays in what it was in. Not under an input method at work: it
  // writes the title again with its next step.
  const content = text?.content ?? '';
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.value === content || composed.current) return;
    const was = read(el);
    el.value = content;
    el.setSelectionRange(carried(was.text, content, was.start), carried(was.text, content, was.end));
    history.current?.reset(read(el));
  }, [content]);

  /**
   * A composition has ended: all of it is one step of the history. Browsers do not agree on
   * whether its last input comes before the end or after, so this is called a moment later, or
   * when the next composition begins, whichever is first.
   */
  const settle = (from: TextState | null) => {
    const el = ref.current;
    if (!el || !from || composed.current !== from) return;
    composed.current = null;
    const now = read(el);
    if (now.text !== from.text) history.current?.record(from, now, 'insertCompositionText');
  };

  if (!text || !field || over) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // No key typed into a title is anyone else's: not a shortcut, not the timeline's.
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const keys = eventKeys(e.nativeEvent);
    if (keys === 'escape' || keys === 'mod+enter') {
      e.preventDefault();
      // Held down, the key that ends the typing does nothing more: Escape does not go on to
      // deselect the title.
      spendKeys();
      end();
      e.currentTarget.blur();
      if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    } else if (keys === 'mod+z') {
      e.preventDefault();
      restore(history.current?.undo());
    } else if (keys === 'mod+shift+z' || keys === 'mod+y') {
      e.preventDefault();
      restore(history.current?.redo());
    }
  };

  return (
    <textarea
      ref={ref}
      className="title-edit"
      aria-label="Title text"
      defaultValue={said}
      wrap={text.boxWidth ? 'soft' : 'off'}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      style={{
        width: field.width,
        height: field.height,
        padding: field.padding.map((p) => `${p}px`).join(' '),
        fontFamily: fontStack(text),
        fontSize: field.fontSize,
        fontWeight: text.weight,
        fontStyle: text.italic ? 'italic' : 'normal',
        lineHeight: `${field.lineHeight}px`,
        letterSpacing: field.letterSpacing,
        textAlign: text.align,
        textTransform: text.uppercase ? 'uppercase' : 'none',
        color: text.gradient.enabled ? text.gradient.from : text.color,
        transform: `matrix(${field.matrix.join(',')})`,
      }}
      onKeyDown={onKeyDown}
      onCompositionStart={(e) => {
        settle(composed.current);
        composed.current = read(e.currentTarget);
      }}
      onCompositionEnd={() => {
        const from = composed.current;
        setTimeout(() => settle(from), 0);
      }}
      onBlur={(e) => {
        // The window going to the back takes the keyboard without the field giving it up.
        if (document.activeElement !== e.currentTarget) end();
      }}
    />
  );
}
