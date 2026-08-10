import { useCallback, useRef, useState } from "preact/hooks";
import type { DropTarget } from "~/engine/reorder";

export type DragState = {
  /** Index of the alert being dragged. */
  from: number;
  /** Vertical distance dragged, for the lifted row's transform. */
  offsetY: number;
  target: DropTarget | null;
};

/** Fraction of a row's height, centred, that counts as "drop onto to group". */
const ONTO_BAND = 0.44;

/** Movement before a press becomes a drag, so a click on the row still works. */
const DRAG_THRESHOLD_PX = 4;

type Row = { index: number; top: number; bottom: number; height: number };

function readRows(list: HTMLElement): Row[] {
  const out: Row[] = [];
  for (const el of list.querySelectorAll<HTMLElement>("[data-index]")) {
    const index = Number(el.dataset.index);
    if (Number.isNaN(index)) continue;
    const r = el.getBoundingClientRect();
    out.push({ index, top: r.top, bottom: r.bottom, height: r.height });
  }
  return out.sort((x, y) => x.index - y.index);
}

/**
 * Decide what a drop at this position means.
 *
 * The middle band of a row means "group with this one"; anywhere else is a
 * boundary between rows. Reserving the centre for grouping is what lets one
 * gesture express both intents without a modifier key.
 */
function targetFor(rows: readonly Row[], y: number, from: number): DropTarget | null {
  if (rows.length === 0) return null;

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (y < first.top) return { kind: "at", index: 0 };
  if (y > last.bottom) return { kind: "at", index: rows.length };

  for (const row of rows) {
    if (y < row.top || y > row.bottom) continue;

    const band = row.height * ONTO_BAND;
    const middleTop = row.top + (row.height - band) / 2;
    if (y >= middleTop && y <= middleTop + band && row.index !== from) {
      return { kind: "onto", index: row.index };
    }
    return { kind: "at", index: y < row.top + row.height / 2 ? row.index : row.index + 1 };
  }
  return null;
}

export function useDragList(onDrop: (from: number, target: DropTarget) => void) {
  const listRef = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const startY = useRef(0);
  const armed = useRef<number | null>(null);

  const finish = useCallback(
    (state: DragState | null) => {
      armed.current = null;
      if (state !== null && state.target !== null) onDrop(state.from, state.target);
      setDrag(null);
    },
    [onDrop],
  );

  const startDrag = useCallback(
    (index: number, event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      startY.current = event.clientY;
      armed.current = index;

      const target = event.currentTarget as HTMLElement | null;
      target?.setPointerCapture?.(event.pointerId);

      // MEASURED ONCE, BEFORE ANYTHING IS TRANSFORMED, and re-measuring per move
      // was a real bug rather than a waste.
      //
      // The drag transform is applied to the very element that carries
      // `data-index`, and getBoundingClientRect() includes transforms — so once a
      // drag started, the dragged row's rect followed the pointer exactly. The
      // pointer's position RELATIVE to that row was therefore constant for the
      // whole gesture, and the drop target came out as a function of where the row
      // was GRABBED rather than where it was dragged to. Neighbours shifting to
      // open a gap moved their rects too.
      //
      // That is what made leaving a group require an actual reposition: the
      // boundary the user aimed at was not the boundary being computed. Layout does
      // not change during a drag — only transforms do, and transforms do not affect
      // layout — so one measurement taken before the first transform is both
      // correct and cheaper.
      //
      // The list not scrolling mid-drag is the assumption here; there is no
      // auto-scroll, and a scroll would previously have been just as wrong.
      const list = listRef.current;
      const rows = list === null ? [] : readRows(list);

      let live: DragState | null = null;

      const move = (e: PointerEvent): void => {
        const offsetY = e.clientY - startY.current;
        if (live === null && Math.abs(offsetY) < DRAG_THRESHOLD_PX) return;

        live = { from: index, offsetY, target: targetFor(rows, e.clientY, index) };
        setDrag(live);
      };

      const up = (): void => {
        globalThis.removeEventListener("pointermove", move);
        globalThis.removeEventListener("pointerup", up);
        globalThis.removeEventListener("pointercancel", cancel);
        finish(live);
      };

      const cancel = (): void => {
        globalThis.removeEventListener("pointermove", move);
        globalThis.removeEventListener("pointerup", up);
        globalThis.removeEventListener("pointercancel", cancel);
        finish(null);
      };

      globalThis.addEventListener("pointermove", move);
      globalThis.addEventListener("pointerup", up);
      globalThis.addEventListener("pointercancel", cancel);
    },
    [finish],
  );

  /**
   * How far a row should slide to open a gap at the drop point.
   *
   * Rows between the source and the destination move by one row height in the
   * opposite direction, which reads as the list making room rather than
   * teleporting on release.
   */
  const shiftFor = useCallback(
    (index: number, rowHeight: number): number => {
      if (drag === null || drag.target === null || index === drag.from) return 0;
      if (drag.target.kind === "onto") return 0;

      const to = drag.target.index;
      if (drag.from < to && index > drag.from && index < to) return -rowHeight;
      if (drag.from > to && index >= to && index < drag.from) return rowHeight;
      return 0;
    },
    [drag],
  );

  return { drag, listRef, startDrag, shiftFor };
}

export { targetFor as __targetFor };
