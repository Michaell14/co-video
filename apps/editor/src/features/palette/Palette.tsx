import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EFFECTS, formatTimecode, TRANSITIONS } from '@tandem/core';
import { useProject } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { COMMANDS, type Command } from '../../state/shortcuts';
import { Dialog, Kbd } from '../../ui/core';
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
  const listRef = useRef<HTMLDivElement>(null);
  const markers = useProject((p) => p.markers);
  const settings = useProject((p) => p.settings);

  const items = useMemo<Item[]>(() => {
    const base: Item[] = COMMANDS.filter((c) => c.id !== 'palette').map((c: Command) => ({ id: c.id, title: c.title, group: c.group, keys: c.keys?.[0], run: c.run }));
    const fx: Item[] = EFFECTS.map((e) => ({ id: `fx:${e.id}`, title: `Add effect: ${e.name}`, group: 'Effects', run: () => cmd.applyEffect(e.id) }));
    const tr: Item[] = TRANSITIONS.map((t) => ({ id: `tr:${t.id}`, title: `Add transition: ${t.name}`, group: 'Transitions', run: () => cmd.applyTransition(t.id) }));
    const mk: Item[] = Object.values(markers)
      .sort((a, b) => a.frame - b.frame)
      .map((m) => ({ id: `mk:${m.id}`, title: `Go to marker: ${m.name}`, group: formatTimecode(m.frame, settings), run: () => cmd.seek(m.frame) }));
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

  return createPortal(
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette__input">
          <Search />
          <input
            autoFocus
            value={query}
            placeholder="Search commands, effects, transitions, markers…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(results.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') run(results[active]);
              else if (e.key === 'Escape') onClose();
            }}
          />
          <Kbd keys="escape" />
        </div>
        <div className="palette__list" ref={listRef}>
          {results.length === 0 && <div className="palette__none">No commands match “{query}”.</div>}
          {results.map((item, i) => (
            <button key={item.id} className="palette__item" data-active={i === active} onPointerMove={() => setActive(i)} onClick={() => run(item)}>
              <span className="palette__title">{item.title}</span>
              <span className="palette__group">{item.group}</span>
              {item.keys && <Kbd keys={item.keys} />}
            </button>
          ))}
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
      </div>
    </Dialog>
  );
}
