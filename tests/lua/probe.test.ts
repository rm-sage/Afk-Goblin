import { describe, expect, it } from "vitest";
import { bar, chatBox, loadPlugin, TICK_US, type LuaPlugin, type SentMessage } from "./harness";

/**
 * The draw-stream probe.
 *
 * Every detector finds its target by a constant someone guessed at, and a wrong
 * guess reads NOTHING rather than reading wrong — which is indistinguishable
 * from an empty screen. Three sessions went into guessing again at constants
 * nobody had checked. This reports what the game actually drew, so the next
 * wrong constant is visible instead of inferred.
 */

function tick(plugin: LuaPlugin): void {
  plugin.frame([], TICK_US);
}

type Report = SentMessage & {
  shapes: Array<{ key: string; count: number; x: number; y: number }>;
  icons: Array<{ id: string | null; x: number; y: number }>;
  bars: Array<{ atlas: string; x: number; y: number; drawn: number; texture: string; tint: string }>;
};

function report(plugin: LuaPlugin): Report | undefined {
  const all = plugin.sent().filter((m) => m.t === "probe");
  return all[all.length - 1] as never;
}

/** Arm the probe and run the two ticks it needs to gather and report. */
function sample(plugin: LuaPlugin, draw: () => void): void {
  plugin.fromUi(`{"t":"probe"}`);
  tick(plugin);
  draw();
  tick(plugin);
}

describe("draw-stream probe", () => {
  it("stays silent until it is asked", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [] })]);
    tick(plugin);

    expect(plugin.sent().filter((m) => m.t === "probe")).toHaveLength(0);

    plugin.close();
  });

  it("reports textured images by their atlas size", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        { kind: "render2d", images: [bar("hp", 1), bar("pray", 1, 1)] },
      ]);
    });

    expect(report(plugin)?.shapes).toContainEqual(
      expect.objectContaining({ key: "image 106x4", count: 2 }),
    );

    plugin.close();
  });

  /**
   * The reading that matters most right now. A resource bar drawn as a flat
   * colour fill has no atlas entry, so the action bar's "106x4 image in one of
   * four colours" test can never match it however right the colours are — and
   * the result is a silent, permanent zero rather than a wrong number.
   */
  it("reports untextured fills by their drawn size and colour", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        {
          kind: "render2d",
          images: [{ x: 10, y: 500, x2: 99, y2: 504, flat: [0xf3, 0x57, 0x37] }],
        },
      ]);
    });

    expect(report(plugin)?.shapes).toContainEqual(
      expect.objectContaining({ key: "flat 89x4 #f35737", count: 1 }),
    );

    plugin.close();
  });

  /**
   * Ten buffs on the bar and five read leaves an open question: are there ten
   * icon draws at the bar's position, or five? One means the pairing is losing
   * them, the other means half the bar is not drawn as icons at all — and those
   * need completely different fixes.
   */
  it("reports every icon draw with its position and signature", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        { kind: "icon", models: 2, verts: 66, x: 10, y: 20 },
        { kind: "icon", models: 1, verts: 18, x: 40, y: 20 },
      ]);
    });

    expect(report(plugin)?.icons).toEqual([
      { id: "2:66", x: 10, y: 20, w: 32, h: 32 },
      { id: "1:18", x: 40, y: 20, w: 32, h: 32 },
    ]);

    plugin.close();
  });

  /**
   * A size on its own does not say what something IS. "Six 27x27 images at
   * y=990" answers the open question — whether half a buff bar is drawn as flat
   * sprites rather than as icons — and a bare count cannot.
   */
  it("reports where each shape was drawn, not only how many", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        { kind: "render2d", images: [{ aw: 27, ah: 27, x: 1516, y: 990 }] },
      ]);
    });

    expect(report(plugin)?.shapes).toContainEqual(
      expect.objectContaining({ key: "image 27x27", x: 1516, y: 990 }),
    );

    plugin.close();
  });

  /**
   * The action bar reads as invisible while four bar-shaped images sit in the
   * draw stream every frame, so the palette is wrong somewhere. Reporting each
   * bar's colour from BOTH sources — its texture and its vertex tint, which
   * disagree when a sprite is shared and tinted — turns that into a value that
   * can simply be read off. The drawn width comes too, because it is what the
   * fill fraction is computed from.
   */
  it("reports a bar-shaped image with both its colours and its drawn width", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        {
          kind: "render2d",
          images: [
            { ...bar("hp", 0.5), rgb: [0xc8, 0xc8, 0xc8], tint: [0xf3, 0x57, 0x37] },
          ],
        },
      ]);
    });

    expect(report(plugin)?.bars).toEqual([
      expect.objectContaining({
        atlas: "106x4",
        texture: "#c8c8c8",
        tint: "#f35737",
        // 1 + half of FILL_W: the drawn width IS the reading, so this is what
        // stats.lua divides to get a fraction.
        drawn: 45.5,
      }),
    ]);

    plugin.close();
  });

  /** One shot only: sampling every image of every frame is far too expensive to leave on. */
  it("disarms itself after reporting once", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([{ kind: "icon", models: 2, verts: 66, x: 10, y: 20 }]);
    });
    expect(plugin.sent().filter((m) => m.t === "probe")).toHaveLength(1);

    plugin.frame([{ kind: "icon", models: 3, verts: 77, x: 10, y: 20 }]);
    tick(plugin);
    tick(plugin);

    expect(plugin.sent().filter((m) => m.t === "probe")).toHaveLength(1);

    plugin.close();
  });

  /** A capped list must not read as a complete one. */
  it("says so when it had to stop counting", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        {
          kind: "render2d",
          // Past MAX_SHAPES, so the shape table fills and starts dropping.
          images: Array.from({ length: 200 }, (_, i) => ({ aw: i + 1, ah: 2, x: 0, y: 0 })),
        },
      ]);
    });

    expect(report(plugin)?.truncated).toBe(true);

    plugin.close();
  });

  /**
   * THE BAR LIST HAS ITS OWN CAP AND USED TO SATURATE IN SILENCE.
   *
   * `truncated` was computed from the shape and icon lists only, so a reading
   * that had dropped the action bar still reported itself complete. That is the
   * worst possible shape for this particular list: it is capped first, because
   * the filter admits every panel rule and border on screen, and it is the one
   * list the whole report exists to carry.
   */
  it("admits when the bar list filled up", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        {
          kind: "render2d",
          // All bar-shaped (>= 60 wide, <= 6 tall) and at distinct positions, so
          // the dedupe keeps every one of them.
          images: Array.from({ length: 60 }, (_, i) => ({ aw: 106, ah: 4, x: i * 8, y: 100 })),
        },
      ]);
    });

    const r = report(plugin);
    expect(r?.bars.length).toBeGreaterThan(12);
    expect(r?.truncated).toBe(true);

    plugin.close();
  });

  /**
   * A reading that fits must NOT cry truncation, or the marker means nothing.
   * Eighteen bar-shaped images is what a real interface draws — ten panel rules,
   * four borders and the four resource bars — and it used to overflow a cap of
   * twelve, dropping whichever were drawn last.
   */
  it("keeps a whole interface's worth of bar-shaped images", async () => {
    const plugin = await loadPlugin();

    sample(plugin, () => {
      plugin.frame([
        {
          kind: "render2d",
          images: [
            ...Array.from({ length: 10 }, (_, i) => ({ aw: 112, ah: 2, x: 0, y: 1090 + i * 38 })),
            ...Array.from({ length: 4 }, (_, i) => ({ aw: 112, ah: 4, x: 0, y: 1320 + i * 44 })),
            ...Array.from({ length: 4 }, (_, i) => ({ aw: 106, ah: 4, x: 1488 + i * 126, y: 1119 })),
          ],
        },
      ]);
    });

    const r = report(plugin);
    expect(r?.bars).toHaveLength(18);
    // The four that matter survived, rather than being crowded out by borders.
    expect(r?.bars.filter((b) => b.atlas === "106x4")).toHaveLength(4);
    expect(r?.truncated).toBe(false);

    plugin.close();
  });
});
