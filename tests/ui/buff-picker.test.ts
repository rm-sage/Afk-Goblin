import { describe, expect, it } from "vitest";
import { orderBuffsForPicker } from "~/ui/CapturePickers";
import type { BuffSlot } from "~/bolt-io/protocol";

function buff(over: Partial<BuffSlot> & { id: string }): BuffSlot {
  return { timeLeft: null, stacks: null, slot: 0, source: "unknown", ...over };
}

describe("orderBuffsForPicker", () => {
  /**
   * Ids are opaque by construction — a model signature, or a hash of the icon's
   * pixels — so position is the only handle a person has on which entry is
   * which. A list whose order does not match the bar makes that handle useless.
   */
  it("lists buffs in bar order, so the list matches the screen", () => {
    const ordered = orderBuffsForPicker([
      buff({ id: "c", slot: 3 }),
      buff({ id: "a", slot: 1 }),
      buff({ id: "b", slot: 2 }),
    ]);

    expect(ordered.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  /**
   * Slot 0 means "position unknown" — an older plugin, or a buff whose x was
   * never read. Sorting numerically would float those to the top and claim they
   * are leftmost, which is a confident answer to a question that has none.
   */
  it("puts unpositioned buffs last rather than first", () => {
    const ordered = orderBuffsForPicker([
      buff({ id: "unknown", slot: 0 }),
      buff({ id: "first", slot: 1 }),
      buff({ id: "second", slot: 2 }),
    ]);

    expect(ordered.map((b) => b.id)).toEqual(["first", "second", "unknown"]);
  });

  it("keeps the relative order of several unpositioned buffs", () => {
    const ordered = orderBuffsForPicker([
      buff({ id: "x", slot: 0 }),
      buff({ id: "y", slot: 0 }),
    ]);

    expect(ordered.map((b) => b.id)).toEqual(["x", "y"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [buff({ id: "b", slot: 2 }), buff({ id: "a", slot: 1 })];
    orderBuffsForPicker(input);

    expect(input.map((b) => b.id)).toEqual(["b", "a"]);
  });
});
