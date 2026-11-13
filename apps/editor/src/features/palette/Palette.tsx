import { Search } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EFFECTS, formatTimecode, TRANSITIONS } from '@tandem/core';
import { useProject } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { COMMANDS, type Command } from '../../state/shortcuts';
import { Dialog, Kbd } from '../../ui/core';
import { useLayer } from '../../ui/layers';
import './palette.css';

interface Item {
  id: string;
  title: string;
  group: string;
  keys?: string;
  run: () => void;
}

/** Subsequence match with a bonus for word starts — forgiving, but ranks obvious hits first. */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === ' ' ? 50 : 0);
  let ti = 0;
  let s = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    s += found === 0 || t[found - 1] === ' ' ? 3 : 1;
    ti = found + 1;
  }
  return s;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const backdropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (item: Item) => `${listId}${item.id}`;
  const markers = useProject((p) => p.markers);
  const settings = useProject((p) => p.settings);

  const items = useMemo<Item[]>(() => {
    const base: Item[] = COMMANDS.filter((c) => c.id !== 'palette').map((c: Command) => ({
      id: c.id,
      title: c.title,
      group: c.group,
      keys: c.keys?.[0],
      run: c.run,
    }));
    const fx: Item[] = EFFECTS.map((e) => ({
      id: `fx:${e.id}`,
      title: `Add effect: ${e.name}`,
      group: 'Effects',
      run: () => cmd.applyEffect(e.id),
    }));
    const tr: Item[] = TRANSITIONS.map((t) => ({
      id: `tr:${t.id}`,
      title: `Add transition: ${t.name}`,
      group: 'Transitions',
      run: () => cmd.applyTransition(t.id),
    }));
    const mk: Item[] = Object.values(markers)
      .sort((a, b) => a.frame - b.frame)
      .map((m) => ({
        id: `mk:${m.id}`,
        title: `Go to marker: ${m.name}`,
        group: formatTimecode(m.frame, settings),
        run: () => cmd.seek(m.frame),
      }));
    return [...base, ...mk, ...fx, ...tr];
  }, [markers, settings]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return items.filter((i) => !i.id.startsWith('fx:') && !i.id.startsWith('tr:'));
    return items
      .map((i) => ({ i, s: score(q, i.title) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.i);
  }, [items, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    // Let the palette unmount first so commands that open dialogs are not immediately closed.
    setTimeout(item.run, 0);
  };

  // The palette owns the keyboard from the moment it opens, wherever focus happens to be: every
  // key is either one of its own or text for the search field, and none reaches the editor's
  // shortcuts behind it.
  useLayer(backdropRef, true, (e) => {
    e.stopPropagation();
    // Enter and the arrows belong to the input method while it is composing.
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) run(results[active]);
    } else if (e.key === 'Escape') onClose();
    else if (e.key === 'Tab') e.preventDefault();
    else inputRef.current?.focus();
  });
  useLayoutEffect(() => inputRef.current?.focus(), []);

  return createPortal(
    <div
      ref={backdropRef}
      className="palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__input">
          <Search />
          {/* Focus stays in the field while the arrow keys walk the list: the field says which
              entry is the highlighted one, so that it is read out as the highlight moves. */}
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={results[active] && optionId(results[active])}
            value={query}
            placeholder="Search commands, effects, transitions, markers…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Kbd keys="escape" />
        </div>
        <div className="palette__list" ref={listRef}>
          {results.length === 0 && <div className="palette__none">No commands match “{query}”.</div>}
          <div id={listId} role="listbox" aria-label="Commands">
            {results.map((item, i) => (
              <button
                key={item.id}
                id={optionId(item)}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className="palette__item"
                data-active={i === active}
                onPointerMove={() => setActive(i)}
                onClick={() => run(item)}
              >
                <span className="palette__title">{item.title}</span>
                <span className="palette__group">{item.group}</span>
                {item.keys && <Kbd keys={item.keys} />}
              </button>
            ))}
          </div>
        </div>
        {/* How much the search found, for someone who cannot see the list grow and shrink. */}
        <div className="sr-only" role="status">
          {results.length === 0
            ? 'No commands match'
            : `${results.length} ${results.length === 1 ? 'command' : 'commands'}`}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Command[]>();
    for (const c of COMMANDS) {
      if (!c.keys?.length) continue;
      const list = m.get(c.group) ?? [];
      list.push(c);
      m.set(c.group, list);
    }
    return Array.from(m.entries());
  }, []);
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="shortcuts">
        {groups.map(([group, list]) => (
          <section key={group}>
            <h4>{group}</h4>
            {list.map((c) => (
              <div key={c.id} className="shortcut">
                <span>{c.title}</span>
                <span className="shortcut__keys">
                  {c.keys!.slice(0, 2).map((k) => (
                    <Kbd key={k} keys={k} />
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
        <section>
          <h4>Mouse</h4>
          {[
            ['Zoom timeline', 'Ctrl / ⌘ + scroll'],
            ['Scroll timeline', 'Shift + scroll'],
            ['Ripple trim', 'Alt + drag edge'],
            ['Roll edit', 'Ctrl / ⌘ + drag cut'],
            ['Duplicate clip', 'Alt + drop'],
            ['Disable snapping', 'Hold Shift while dragging'],
            ['Fine control', 'Shift / Alt on number fields'],
            ['Reset a control', 'Double-click it'],
          ].map(([a, b]) => (
            <div key={a} className="shortcut">
              <span>{a}</span>
              <span className="shortcut__keys muted">{b}</span>
            </div>
          ))}
        </section>
        <section>
          <h4>Sliders</h4>
          {[
            ['Move a step', 'Arrow keys'],
            ['Move ten steps', 'Shift + arrow keys'],
            ['Move a tenth of the range', 'Page Up / Page Down'],
            ['Go to either end', 'Home / End'],
            ['Reset to the default', 'Delete'],
          ].map(([a, b]) => (
            <div key={a} className="shortcut">
              <span>{a}</span>
              <span className="shortcut__keys muted">{b}</span>
            </div>
          ))}
        </section>
      </div>
    </Dialog>
  );
}
