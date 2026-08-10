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
  /**
   * THE REAL INTERFACE, restated from a live probe reading on 2026-08-09 rather
   * than invented. Both bugs this reproduces presented identically in game — as
   * "the counter is not on screen" — and neither was visible to a fixture I had
   * written myself.
   *
   *   text "XP"         at 3041,1111 13x9      <- the column header
   *   text "XP"         at 3128,1111 13x9      <- the "XP" OF "XP/h"
   *   text "/"          at 3142,1115 5x16      <- four pixels below their baseline
   *   text "h"          at 3147,1111 6x10
   *   text "ETA"        at 3215,1111 22x9
   *   text "73,734"     at 3042,1136 37x11
   *   text "37,138,020" at 3041,1163 61x11
   *   text "27,489,279" at 3042,1190 60x11
   *   text "Gain"       at 3041,1214 25x10     <- the second table starts here
   *   text "119,949,823" ...
   *
   * At a baseline tolerance of 3, "XP/h" fragmented: its "XP" became a run
   * indistinguishable from the real header, and the orphaned "/" became a table
   * ROW four pixels below the header — which ended the table before a single value
   * was read.
   */
  it("reads the counter as the game really draws it", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          ...fontRun("XP", { x: 3041, y: 1111 }, 7, 700),
          ...fontRun("XP/h", { x: 3128, y: 1111 }, 7, 900),
          ...fontRun("ETA", { x: 3215, y: 1111 }, 7, 1100),
          ...fontRun("73,734", { x: 3042, y: 1136 }, 7, 1300),
          ...fontRun("82,407", { x: 3128, y: 1136 }, 7, 1500),
          ...fontRun("37,138,020", { x: 3041, y: 1163 }, 7, 1700),
          ...fontRun("77,427", { x: 3129, y: 1163 }, 7, 1900),
          ...fontRun("5w", { x: 3215, y: 1161 }, 7, 2100),
          ...fontRun("27,489,279", { x: 3042, y: 1190 }, 7, 2300),
          ...fontRun("64,847", { x: 3128, y: 1190 }, 7, 2500),
          ...fontRun("Gain", { x: 3041, y: 1214 }, 7, 2700),
          ...fontRun("Drops", { x: 3128, y: 1217 }, 7, 2900),
          ...fontRun("GP/h", { x: 3215, y: 1214 }, 7, 3100),
          ...fontRun("119,949,823", { x: 3041, y: 1239 }, 7, 3300),
        ],
      },
    ]);
    tick(plugin);

    expect(totals(plugin)).toEqual({ tot: 73734 + 37138020 + 27489279 });
    expect(plugin.latest()?.diag.xpCounterFound).toBe(true);
    expect(plugin.latest()?.diag.xpCells).toEqual(["73,734", "37,138,020", "27,489,279"]);

    plugin.close();
  });

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
   * READS THE COUNTER EVEN WHERE CHAT IS, which is the opposite of what this
   * asserted a version ago and the change fixed a total failure in game.
   *
   * While XP meant reading floating "+N" text, a chat line saying "+50" was
   * indistinguishable from a drop, so batches chat had claimed were skipped.
   * Anchored on a column header that reasoning no longer holds: a chat line would
   * have to contain "XP" as its own run above rows whose leftmost run is a number.
   * Meanwhile the cost of being wrong is total — this side cannot see how the game
   * groups its interfaces into batches, so if the counter ever shares one with
   * chat, skipping it loses XP entirely. Which is what happened.
   */
  it("reads a counter that shares a batch with chat", async () => {
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

    expect(totals(plugin)).toEqual({ tot: 61983 });

    plugin.close();
  });

  /**
   * CONFIRMED IN A LIVE READING: the counter and the chat box are drawn in the
   * SAME batch — both batch 23 — so every chat line below the header is a
   * candidate row. It only worked because the "Gain" header sorted above them and
   * stopped the scan first, which is luck rather than design.
   *
   * The header row's own x-span is the bound. Chat sat at x=10 and x=638 in that
   * reading while the counter's headers ran 3041..3237.
   */
  it("ignores text elsewhere on screen that shares the counter's batch", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          // The counter, with NO second table below it to stop the scan.
          ...counter({ x: 3041, y: 1111 }, [["170,102", "73,798", "-"]]),
          // A chat log far to the left, below the header baseline.
          ...fontRun("[01:31:12]Youcapturethefragment", { x: 638, y: 1336 }, 7, 4000),
          // And a readout far to the right.
          ...fontRun("990/990", { x: 2384, y: 1358 }, 7, 5000),
        ],
      },
    ]);
    tick(plugin);

    expect(totals(plugin)).toEqual({ tot: 170102 });
    expect(plugin.latest()?.diag.xpCells).toEqual(["170,102"]);

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
