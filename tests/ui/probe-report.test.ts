import { describe, expect, it } from "vitest";
import { probeReport, selectAndCopy, type CopyTarget, type Reportable } from "~/ui/probe-report";

/**
 * A reading shaped like the one taken in-game on 2026-08-07: four bar images,
 * the buff bar's icons, and a shape histogram.
 */
function reading(over: Partial<Reportable> = {}): Reportable {
  return {
    bars: [
      { atlas: "106x4", x: 1200, y: 1400, drawn: 89, texture: "#9d9d9d", tint: "#f35737" },
      { atlas: "106x4", x: 1200, y: 1410, drawn: 44, texture: "#9d9d9d", tint: "#e3b621" },
    ],
    icons: [
      { id: "1:366", x: 1546, y: 990, w: 27, h: 27 },
      { id: null, x: 1576, y: 990, w: 27, h: 27 },
    ],
    shapes: [{ key: "image 106x4", count: 52, x: 1200, y: 1400 }],
    truncated: false,
    ...over,
  };
}

describe("probeReport", () => {
  // THE REGRESSION THIS MODULE EXISTS FOR. The bar lines carry the two colour
  // readings that identify a resource bar, and the on-screen dump used to be
  // built without them -- so the one section the reading was taken for was the
  // one section that never reached anybody.
  it("puts the bars first, with both colour readings", () => {
    const lines = probeReport(reading()).split("\n");
    expect(lines[0]).toBe("bar 106x4 at 1200,1400 drawn 89px  texture #9d9d9d  tint #f35737");
    expect(lines[1]).toContain("tint #e3b621");
  });

  it("reports every section", () => {
    const text = probeReport(reading());
    expect(text).toContain("icon 1:366 at 1546,990 27x27");
    expect(text).toContain("52x image 106x4 first at 1200,1400");
  });

  // A signature that could not be derived is a fact about the icon, not a blank.
  it("names an icon whose signature could not be read", () => {
    expect(probeReport(reading())).toContain("icon unreadable at 1576,990");
  });

  it("says so when the reading was capped, and stays silent when it was not", () => {
    expect(probeReport(reading({ truncated: true }))).toContain("capped");
    expect(probeReport(reading())).not.toContain("capped");
  });

  it("produces no stray blank lines when a section is empty", () => {
    const text = probeReport({ bars: [], icons: [], shapes: [], truncated: false });
    expect(text).toBe("");
  });
});

/** A DOM stand-in: `node` environment has no document to borrow. */
function fakeTarget(options: { copyResult?: boolean; throws?: boolean; noView?: boolean } = {}) {
  const calls = { selected: 0, cleared: 0, added: 0, copies: 0 };
  const range = {
    selectNodeContents: () => {
      calls.selected += 1;
    },
  };
  const selection = {
    removeAllRanges: () => {
      calls.cleared += 1;
    },
    addRange: () => {
      calls.added += 1;
    },
  };
  const node = {
    ownerDocument: {
      createRange: () => range,
      execCommand: () => {
        calls.copies += 1;
        if (options.throws === true) throw new Error("execCommand is gone");
        return options.copyResult ?? true;
      },
      defaultView: options.noView === true ? null : { getSelection: () => selection },
    },
  } as unknown as CopyTarget;
  return { node, calls };
}

describe("selectAndCopy", () => {
  it("selects the node's contents and reports the copy landing", () => {
    const { node, calls } = fakeTarget();
    expect(selectAndCopy(node)).toBe(true);
    expect(calls.selected).toBe(1);
    expect(calls.added).toBe(1);
    expect(calls.copies).toBe(1);
  });

  // The button must never say "Copied." on a copy that did not happen. Claiming
  // success is worse than the dead button was: it sends someone off to paste
  // whatever was on the clipboard before.
  it("reports failure when the copy is refused", () => {
    const { node } = fakeTarget({ copyResult: false });
    expect(selectAndCopy(node)).toBe(false);
  });

  // execCommand is deprecated and may be removed. When it goes, the selection is
  // still on screen and Ctrl+C takes it -- so the failure path must still have
  // made that selection.
  it("leaves the text selected when copying throws", () => {
    const { node, calls } = fakeTarget({ throws: true });
    expect(selectAndCopy(node)).toBe(false);
    expect(calls.selected).toBe(1);
    expect(calls.added).toBe(1);
  });

  it("gives up quietly when there is no selection to make", () => {
    const { node, calls } = fakeTarget({ noView: true });
    expect(selectAndCopy(node)).toBe(false);
    expect(calls.copies).toBe(0);
  });

  it("gives up quietly on a detached node", () => {
    expect(selectAndCopy({ ownerDocument: null })).toBe(false);
  });
});
