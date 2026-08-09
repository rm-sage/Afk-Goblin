import { describe, expect, it } from "vitest";
import { chatBox, fontRun, loadPlugin, TICK_US, type ImageSpec, type LuaPlugin } from "./harness";

/**
 * XP read off the XP counter interface.
 *
 * NOT off the floating "+N" drops, which this used to read. A drop lingers on
 * screen for about five seconds while it fades, so it was counted again on every
 * tick until it vanished and an inactivity alert fired five seconds late — which
 * the user reported as killing the feature. Deduping across ticks is not an
 * option: two genuine identical drops would collapse, the total would stop moving
 * while XP was still being gained, and the alert would fire DURING activity.
 *
 * A cumulative total changes the instant XP is gained and then holds still.
 */

function tick(plugin: LuaPlugin): void {
  plugin.frame([], TICK_US);
}

/** The XP totals on the newest snapshot, or null when the counter was unreadable. */
function totals(plugin: LuaPlugin): Record<string, number> | null {
  return plugin.latest()?.xpTotals ?? null;
}

/**
 * The counter as the user's screenshot shows it: an "XP | XP/h | ETA" table, then
 * a SECOND table headed "Gain | Drops | GP/h" whose rows hold equally large
 * comma-separated numbers.
 *
 * Rows are laid out on baselines 14px apart. `y` is the baseline, since that is
 * what groups a row — the glyphs on it have different heights.
 */
function counter(
  at: { x: number; y: number },
  rows: string[][],
  headers: string[] = ["XP", "XP/h", "ETA"],
): ImageSpec[] {
  const COL_X = [0, 120, 240];
  const images: ImageSpec[] = [];
  let atlas = 700;

  headers.forEach((h, col) => {
    images.push(...fontRun(h, { x: at.x + COL_X[col]!, y: at.y }, 7, atlas));
    atlas += 200;
  });

  rows.forEach((cells, row) => {
    cells.forEach((cell, col) => {
      if (cell === "") return;
      images.push(...fontRun(cell, { x: at.x + COL_X[col]!, y: at.y + 14 * (row + 1) }, 7, atlas));
      atlas += 200;
    });
  });

  return images;
}

describe("XP counter reading", () => {
  it("reads the leftmost column of every skill row", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: counter({ x: 40, y: 100 }, [
          ["61,983", "59,632", "-"],
          ["37,135,774", "0", "-"],
        ]),
      },
    ]);
    tick(plugin);

    expect(totals(plugin)).toEqual({ tot: 61983 + 37135774 });
    expect(plugin.latest()?.diag.xpCounterFound).toBe(true);

    plugin.close();
  });

  /**
   * THE TRAP IN THE REAL INTERFACE. A second table sits below, headed "Gain |
   * Drops | GP/h", holding numbers as large as the XP ones — 119,475,197 in the
   * user's screenshot. Anything anchored on "a big comma-separated number" would
   * swallow it. The XP table ends at the first row with no number on it, which is
   * that header.
   */
  it("stops at the second table rather than counting its numbers", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          ...counter({ x: 40, y: 100 }, [
            ["61,983", "59,632", "-"],
            ["37,135,774", "0", "-"],
            ["27,479,774", "59,546", "7w"],
            // The lower table's header, then its row.
            ["Gain", "Drops", "GP/h"],
            ["119,475,197", "0", "5,610,660"],
          ]),
        ],
      },
    ]);
    tick(plugin);

    expect(totals(plugin)).toEqual({ tot: 61983 + 37135774 + 27479774 });

    plugin.close();
  });

  /**
   * The other columns are user-configurable, so requiring "XP/h" or "ETA" would go
   * permanently blind for anyone who turns one off — and blindness resolves to
   * silence, which is worse than the failure it replaced. Only "XP" is required.
   */
  it("reads the counter with the other columns switched off", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "render2d", images: counter({ x: 40, y: 100 }, [["61,983"]], ["XP"]) },
    ]);
    tick(plugin);

    expect(totals(plugin)).toEqual({ tot: 61983 });

    plugin.close();
  });

  /**
   * UNREADABLE MUST BE REPRESENTABLE. While XP was accumulated from drops the
   * tally only ever grew, so once one drop had been seen a reader that went blind
   * was indistinguishable from "XP stopped" — and an inactivity alert FIRED on a
   * detection failure. A level can be absent.
   */
  it("reports nothing when the counter is not on screen", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("37,135,774", { x: 900, y: 200 }) }]);
    tick(plugin);

    expect(totals(plugin)).toBeNull();
    expect(plugin.latest()?.diag.xpCounterFound).toBe(false);

    plugin.close();
  });

  /**
   * "37.1M" is a real reading but a coarse one: it only moves on a gain of tens of
   * thousands, so an inactivity alert built on it would fire while training
   * continues. Reported with a reason rather than acted on.
   */
  it("declines an abbreviated total rather than acting on it", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "render2d", images: counter({ x: 40, y: 100 }, [["37.1M", "59,632", "-"]]) },
    ]);
    tick(plugin);

    expect(totals(plugin)).toBeNull();
    expect(plugin.latest()?.diag.xpCoarse).toBe(true);
    expect(plugin.latest()?.diag.xpCounterFound).toBe(true);

    plugin.close();
  });

  it("reports the raw cell text so a misread is visible", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: counter({ x: 40, y: 100 }, [
          ["61,983", "59,632", "-"],
          ["37,135,774", "0", "-"],
        ]),
      },
    ]);
    tick(plugin);

    expect(plugin.latest()?.diag.xpCells).toEqual(["61,983", "37,135,774"]);

    plugin.close();
  });

  /**
   * Chat and the counter are drawn in the same font, and a chat line could easily
   * contain "XP" followed by numbers. main.lua keeps the scan off any batch chat
   * claimed.
   */
  it("does not read a counter out of a chat batch", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          ...chatBox({ x: 20, y: 400 }, { messages: [] }).images,
          ...counter({ x: 40, y: 420 }, [["61,983"]], ["XP"]),
        ],
      },
    ]);
    tick(plugin);

    expect(totals(plugin)).toBeNull();

    plugin.close();
  });

  /**
   * A total holds still between gains, which is the entire point — the drop reader
   * kept climbing for five seconds after XP stopped.
   */
  it("holds the same total while no XP is gained", async () => {
    const plugin = await loadPlugin();
    const frame = {
      kind: "render2d" as const,
      images: counter({ x: 40, y: 100 }, [["61,983", "59,632", "-"]]),
    };

    tick(plugin);
    plugin.frame([frame]);
    tick(plugin);
    expect(totals(plugin)).toEqual({ tot: 61983 });

    for (let i = 0; i < 5; i++) plugin.frame([frame]);
    tick(plugin);
    expect(totals(plugin)).toEqual({ tot: 61983 });

    plugin.close();
  });
});
