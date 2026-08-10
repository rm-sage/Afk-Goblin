import { describe, expect, it } from "vitest";
import { __targetFor as targetFor } from "~/ui/useDragList";

/** Four 40px rows starting at y=100. */
const rows = [0, 1, 2, 3].map((index) => ({
  index,
  top: 100 + index * 40,
  bottom: 140 + index * 40,
  height: 40,
}));

describe("targetFor", () => {
  it("returns nothing for an empty list", () => {
    expect(targetFor([], 120, 0)).toBeNull();
  });

  it("drops at the top when above every row", () => {
    expect(targetFor(rows, 10, 3)).toEqual({ kind: "at", index: 0 });
  });

  it("drops at the end when below every row", () => {
    expect(targetFor(rows, 900, 0)).toEqual({ kind: "at", index: 4 });
  });

  it("drops before a row when in its upper edge", () => {
    // Row 1 spans 140..180; 145 is above its centre band.
    expect(targetFor(rows, 145, 3)).toEqual({ kind: "at", index: 1 });
  });

  it("drops after a row when in its lower edge", () => {
    expect(targetFor(rows, 175, 3)).toEqual({ kind: "at", index: 2 });
  });

  // Reserving the centre for grouping is what lets one gesture mean both things.
  it("groups when over the centre of another row", () => {
    expect(targetFor(rows, 160, 3)).toEqual({ kind: "onto", index: 1 });
  });

  it("never groups a row with itself", () => {
    const r = targetFor(rows, 160, 1);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("at");
  });

  it("still reorders past the row being dragged", () => {
    expect(targetFor(rows, 145, 1)).toEqual({ kind: "at", index: 1 });
    expect(targetFor(rows, 175, 1)).toEqual({ kind: "at", index: 2 });
  });

  it("treats the exact top and bottom edges as boundaries, not grouping", () => {
    expect(targetFor(rows, 100, 3)).toEqual({ kind: "at", index: 0 });
    expect(targetFor(rows, 140, 3)?.kind).toBe("at");
  });
});

/**
 * THE ROWS HANDED IN MUST BE LAYOUT POSITIONS, NOT TRANSFORMED ONES.
 *
 * The drag transform is applied to the same element that carries `data-index`,
 * and getBoundingClientRect() includes transforms — so re-measuring mid-drag made
 * the dragged row's rect follow the pointer exactly. The pointer's position
 * relative to that row was then constant, and the target came out as a function
 * of where the row was GRABBED rather than where it was dragged.
 *
 * These pin down what the caller must preserve: with static rows, the target is a
 * function of the pointer alone, and dragging a row within its own bounds still
 * resolves to the boundary the pointer is nearest.
 */
describe("targetFor with the dragged row still at its layout position", () => {
  it("resolves the boundary from the pointer, not from the grab offset", () => {
    // Row 1 spans 140..180. Its own centre band is reserved for grouping only when
    // the row is not the one being dragged, so dragging row 1 within itself must
    // still yield a boundary — and which boundary depends on the pointer.
    expect(targetFor(rows, 145, 1)).toEqual({ kind: "at", index: 1 });
    expect(targetFor(rows, 175, 1)).toEqual({ kind: "at", index: 2 });
  });

  it("lets the lower member of a trailing pair reach the boundary past itself", () => {
    // Two rows only: dragging row 1 downward past its own midpoint targets index 2,
    // which is what applyDrop reads as "out of the group".
    const pair = rows.slice(0, 2);
    expect(targetFor(pair, 175, 1)).toEqual({ kind: "at", index: 2 });
    expect(targetFor(pair, 900, 1)).toEqual({ kind: "at", index: 2 });
  });

  it("lets the upper member reach the boundary above itself", () => {
    const pair = rows.slice(0, 2);
    expect(targetFor(pair, 105, 0)).toEqual({ kind: "at", index: 0 });
    expect(targetFor(pair, 10, 0)).toEqual({ kind: "at", index: 0 });
  });
});