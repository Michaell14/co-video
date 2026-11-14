/**
 * Pointer-driven drag and drop for things that live inside the app (assets, effects, transitions,
 * presets). Unlike HTML5 DnD this gives drop targets live pointer positions, which the timeline
 * needs to draw an exact, snapped preview of where a clip will land.
 */
import { GripVertical } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { ShapeProps, TextProps } from '@tandem/core';
import { isDoublePress, type Press } from './press';

export type DragPayload =
  /**
   * A file of the project. With `sourceIn` and `sourceOut`, in seconds, it is that stretch of the
   * file and not all of it: what is marked in the source monitor.
   */
  | { kind: 'asset'; assetId: string; sourceIn?: number; sourceOut?: number }
  | { kind: 'effect'; type: string }
  | { kind: 'transition'; type: string }
  | { kind: 'text'; text: Partial<TextProps> }
  | { kind: 'shape'; shape: Partial<ShapeProps> }
  | { kind: 'generator'; type: 'solid' | 'adjustment' };

interface DragState {
  payload: DragPayload | null;
  label: string;
  x: number;
  y: number;
}

export const useDrag = create<DragState>(() => ({ payload: null, label: '', x: 0, y: 0 }));

type DropHandler = (payload: DragPayload, x: number, y: number) => boolean;
const handlers = new Set<DropHandler>();

/** Register a drop handler. Return true from the handler to accept the drop. */
export function onDrop(handler: DropHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** The last press that began on a drag source, to recognise the second press of a double-click. */
let lastPress: (Press & { source: EventTarget }) | null = null;

/**
 * Begin a drag from a pointerdown. A plain click (no movement) calls `onClick` instead, once per
 * double-click: people double-click a library tile to apply it and mean one, not two.
 */
export function beginDrag(
  e: React.PointerEvent,
  payload: DragPayload,
  label: string,
  onClick?: () => void,
): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const press = { time: e.timeStamp, x: startX, y: startY, source: e.currentTarget };
  const repeated = lastPress?.source === press.source && isDoublePress(lastPress, press);
  lastPress = press;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      document.body.style.cursor = 'grabbing';
    }
    useDrag.setState({ payload, label, x: ev.clientX, y: ev.clientY });
  };
  const finish = (ev: PointerEvent, cancelled: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', key, true);
    document.body.style.cursor = '';
    if (dragging) {
      if (!cancelled) {
        for (const h of Array.from(handlers)) if (h(payload, ev.clientX, ev.clientY)) break;
      }
      useDrag.setState({ payload: null });
    } else if (!cancelled && !repeated) onClick?.();
  };
  const up = (ev: PointerEvent) => finish(ev, false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      finish(new PointerEvent('pointerup'), true);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', key, true);
}

export function DragLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const active = useDrag((s) => !!s.payload);
  const label = useDrag((s) => s.label);
  useEffect(
    () =>
      useDrag.subscribe((s) => {
        if (ref.current) ref.current.style.transform = `translate(${s.x + 12}px, ${s.y + 14}px)`;
      }),
    [],
  );
  if (!active) return null;
  const { x, y } = useDrag.getState();
  return (
    <div ref={ref} className="drag-ghost" style={{ transform: `translate(${x + 12}px, ${y + 14}px)` }}>
      <GripVertical />
      {label}
    </div>
  );
}

export const insideRect = (r: DOMRect, x: number, y: number): boolean =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
