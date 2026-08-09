import { describe, expect, it } from "vitest";
import { buffDraw, loadPlugin, TICK_US, type LuaPlugin } from "./harness";

/**
 * Buff detection, driven through main.lua rather than through the module alone.
 *
 * The module was never the problem. Both bugs this file guards against lived in
 * the WIRING — the order main.lua calls request and read in, and how long a scan
 * stays open — which is exactly what a module-level test cannot see.
 *
 * TIMING. A tick fires at the swap-buffers that ends a frame, and it publishes
 * what the frames since the previous tick gathered. So a buff drawn on frame N
 * appears in the snapshot sent by the NEXT tick, never the one before it.
 */

/** A tick with nothing drawn. */
function tick(plugin: LuaPlugin): void {
  plugin.frame([], TICK_US);
}

/**
 * The four quads the game draws round one buff, as measured on 2026-08-07:
 *
 *   144x flat 27x1 #5a9619 first at 1606,990
 *   144x flat 1x25 #5a9619 first at 1606,991
 *
 * The top segment sits at the icon's own corner — which is the position the
 * vendored module matches against — and the left segment one pixel below it.
 */
function outlineBox(x: number, rgb: [number, number, number] = [90, 150, 25]) {
  return [
    { flat: rgb, x, y: 990, aw: 27, ah: 1 },
    { flat: rgb, x, y: 991, aw: 1, ah: 25 },
    { flat: rgb, x, y: 1016, aw: 27, ah: 1 },
    { flat: rgb, x: x + 26, y: 991, aw: 1, ah: 25 },
  ];
}

/** The buff list from the newest snapshot. */
function buffs(plugin: LuaPlugin): Array<{ id: string; timeLeft: number | null }> {
  return (plugin.latest()?.buffs ?? []) as Array<{ id: string; timeLeft: number | null }>;
}

describe("buff detection", () => {
  /**
   * THE REGRESSION TEST.
   *
   * main.lua called buffs.request(), which cleared the list, and then
   * buffs.read() in the same callback — so the bridge sent an empty list on
   * every tick no matter what had been drawn. It survived a live session and a
   * fix attempt, because from the outside "no buffs" looks exactly like an empty
   * buff bar.
   */
  it("puts a buff drawn during the tick into the next snapshot", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame(buffDraw(2, 1344, { number: 27, parens: 1 }));
    tick(plugin);

    expect(buffs(plugin)).toEqual([{ id: "2:1344", timeLeft: 27, stacks: 1 }]);

    plugin.close();
  });

  /**
   * The other half of that bug's cover story: if the list were merely stale
   * rather than empty, an expired buff would stay on it forever and every "is
   * this buff still up?" alert would be wrong in the opposite direction.
   */
  it("drops a buff once the game stops drawing it", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame(buffDraw(2, 1344, { number: 27 }));
    tick(plugin);
    expect(buffs(plugin)).toHaveLength(1);

    plugin.idle(3);
    tick(plugin);
    expect(buffs(plugin)).toEqual([]);

    plugin.close();
  });

  /**
   * Reading spans the whole tick, and a tick is around 36 frames. Publishing
   * every sighting would report the same buff dozens of times over.
   */
  it("reports a buff drawn on every frame exactly once", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    for (let i = 0; i < 10; i++) plugin.frame(buffDraw(2, 1344, { number: 27 }));
    tick(plugin);

    expect(buffs(plugin)).toHaveLength(1);

    plugin.close();
  });

  /**
   * Detection used to sample ONE frame per tick. Nothing promises the game draws
   * a given icon on the frame that happens to be sampled, so a buff could be on
   * the bar for minutes and be seen on none of the frames looked at.
   */
  it("sees a buff drawn on only one frame of the tick", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.idle(12);
    plugin.frame(buffDraw(2, 1344, { number: 27 }));
    plugin.idle(12);
    tick(plugin);

    expect(buffs(plugin)).toEqual([{ id: "2:1344", timeLeft: 27, stacks: null }]);

    plugin.close();
  });

  /**
   * REPRODUCES WHAT WAS SEEN IN GAME: ten buffs on the bar, six read.
   *
   * An icon's timer text arrives on a later render2d, and detection kept exactly
   * ONE icon waiting for it. The buff bar draws its icons in a run, so every icon
   * but the last was discarded before its text arrived — silently, and in the
   * same order every frame, so the same buffs went missing every time.
   *
   * Each text batch here names the icon it belongs to, so a pairing that merely
   * matched the nearest waiting icon would fail this.
   */
  it("reads every buff when the bar draws its icons in a run", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 2, verts: 66, x: 10, y: 20 },
      { kind: "icon", models: 1, verts: 18, x: 40, y: 20 },
      { kind: "icon", models: 2, verts: 1239, x: 70, y: 20 },
      { kind: "render2d", images: [{ buff: { valid: true, number: 180, at: [10, 20] } }] },
      { kind: "render2d", images: [{ buff: { valid: true, number: 540, at: [40, 20] } }] },
      { kind: "render2d", images: [{ buff: { valid: true, number: 360, at: [70, 20] } }] },
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([
      { id: "2:66", timeLeft: 180, stacks: null },
      { id: "1:18", timeLeft: 540, stacks: null },
      { id: "2:1239", timeLeft: 360, stacks: null },
    ]);

    plugin.close();
  });

  /**
   * REPRODUCES WHAT WAS SEEN IN GAME: six buffs on the bar, three read, the same
   * three every time.
   *
   * A live draw stream showed the bar drawing all six icons in a run and their
   * text in the batches afterwards. An unmatched icon was carried across only
   * four batches before being dropped, so however many buffs were on the bar,
   * only the first few could ever pair — and it was always the same few, because
   * the draw order does not change.
   */
  it("reads a full bar whose icons are all drawn before any of their text", async () => {
    const plugin = await loadPlugin();

    // Six buffs, laid out as the probe found them: 27x27 icons, 30px apart.
    const bar = [1486, 1516, 1546, 1606, 1636, 1666].map((x, n) => ({
      x,
      models: 1 + (n % 2),
      verts: 100 + n,
    }));

    tick(plugin);
    plugin.frame([
      ...bar.map((b) => ({ kind: "icon" as const, models: b.models, verts: b.verts, x: b.x, y: 990 })),
      ...bar.map((b) => ({
        kind: "render2d" as const,
        images: [{ buff: { valid: true, number: 60, at: [b.x, 990] as [number, number] } }],
      })),
    ]);
    tick(plugin);

    expect(buffs(plugin)).toHaveLength(6);

    plugin.close();
  });

  /** The interleaved order has to keep working too, and must not mispair. */
  it("pairs each icon with its own text when they alternate", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 2, verts: 66, x: 10, y: 20 },
      { kind: "render2d", images: [{ buff: { valid: true, number: 180, at: [10, 20] } }] },
      { kind: "icon", models: 1, verts: 18, x: 40, y: 20 },
      { kind: "render2d", images: [{ buff: { valid: true, number: 540, at: [40, 20] } }] },
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([
      { id: "2:66", timeLeft: 180, stacks: null },
      { id: "1:18", timeLeft: 540, stacks: null },
    ]);

    plugin.close();
  });

  /**
   * Carrying every icon across every batch cost 2,366 parse attempts per frame
   * in a live client — worth five to ten FPS — and almost all of it was spent on
   * inventory items that could never be a buff. Once one buff has been read, its
   * icon size is known and everything else can be dropped on sight.
   */
  it("stops carrying icons that are not the size a buff is drawn at", async () => {
    const plugin = await loadPlugin();

    const buffIcon = { kind: "icon" as const, models: 2, verts: 66, x: 10, y: 20, w: 27, h: 27 };
    const inventory = Array.from({ length: 20 }, (_, n) => ({
      kind: "icon" as const,
      models: 5,
      verts: 500 + n,
      x: 900 + n,
      y: 900,
      w: 36,
      h: 32,
    }));
    const text = {
      kind: "render2d" as const,
      images: [{ buff: { valid: true, number: 60, at: [10, 20] as [number, number] } }],
    };
    const noise = Array.from({ length: 10 }, () => ({ kind: "render2d" as const, images: [{}] }));

    // First tick teaches the size.
    tick(plugin);
    plugin.frame([buffIcon, ...inventory, text, ...noise]);
    tick(plugin);
    expect(buffs(plugin)).toHaveLength(1);
    const learning = plugin.latest()?.diag.buffPairAttempts ?? 0;

    // Second tick should barely try anything but the buff icon itself.
    plugin.frame([buffIcon, ...inventory, text, ...noise]);
    tick(plugin);
    expect(buffs(plugin)).toHaveLength(1);

    const settled = plugin.latest()?.diag.buffPairAttempts ?? 0;
    expect(settled).toBeLessThan(learning / 4);

    plugin.close();
  });

  /** A learned size must not be able to lock detection out permanently. */
  it("forgets the learned size when nothing reads for several ticks", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 2, verts: 66, x: 10, y: 20, w: 27, h: 27 },
      { kind: "render2d", images: [{ buff: { valid: true, number: 60, at: [10, 20] } }] },
    ]);
    tick(plugin);
    expect(buffs(plugin)).toHaveLength(1);

    // The bar changes size — every icon is now a size the filter rejects.
    for (let i = 0; i < 6; i++) {
      plugin.frame([
        { kind: "icon", models: 3, verts: 77, x: 10, y: 20, w: 40, h: 40 },
        { kind: "render2d", images: [{ buff: { valid: true, number: 30, at: [10, 20] } }] },
      ]);
      tick(plugin);
    }

    expect(buffs(plugin)).toEqual([{ id: "3:77", timeLeft: 30, stacks: null }]);

    plugin.close();
  });

  /** Inventory icons must not be carried along being retried all tick. */
  it("gives up on an icon whose text never arrives", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 9, verts: 99, x: 500, y: 500 },
      ...Array.from({ length: 6 }, () => ({
        kind: "render2d" as const,
        images: [{ buff: { valid: true, number: 5, at: [0, 0] as [number, number] } }],
      })),
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([]);
    expect(plugin.latest()?.diag.buffIconDraws).toBe(1);

    plugin.close();
  });

  it("keeps debuffs separate from buffs", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame(buffDraw(2, 1344, { number: 27, isbuff: true }));
    plugin.frame(buffDraw(3, 902, { number: 9, isbuff: false }));
    tick(plugin);

    const state = plugin.latest();
    expect(state?.buffs).toEqual([{ id: "2:1344", timeLeft: 27, stacks: null }]);
    expect(state?.debuffs).toEqual([{ id: "3:902", timeLeft: 9, stacks: null }]);

    plugin.close();
  });

  /**
   * The signature IS the id, so two buffs must not collapse into one just
   * because they were drawn back to back.
   */
  it("tells two different buffs apart by their signature", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame(buffDraw(2, 1344, { number: 27 }));
    plugin.frame(buffDraw(2, 806, { number: 300 }));
    tick(plugin);

    expect(buffs(plugin).map((b) => b.id).sort()).toEqual(["2:1344", "2:806"]);

    plugin.close();
  });

  /**
   * An icon whose text will not parse must not be mistaken for a buff with no
   * timer — that would put junk in the picker for every inventory item on
   * screen.
   */
  it("ignores an icon whose details do not read as a buff", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 1, verts: 40, x: 5, y: 5 },
      { kind: "render2d", images: [{ buff: { valid: false } }] },
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([]);

    plugin.close();
  });
});

describe("buff diagnostics", () => {
  /**
   * These counters exist to tell an empty buff bar from broken detection, and
   * they were themselves zeroed by the ordering bug — so the one thing that
   * could have explained the empty picker was empty for the same reason.
   */
  it("counts icon draws even when none of them read as a buff", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 1, verts: 40 },
      { kind: "render2d", images: [{ buff: { valid: false } }] },
      { kind: "icon", models: 1, verts: 41 },
      { kind: "render2d", images: [{ buff: { valid: false } }] },
    ]);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.buffIconDraws).toBe(2);
    expect(diag?.buffIconsRead).toBe(0);

    plugin.close();
  });

  it("counts how many icons were read as buffs", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame(buffDraw(2, 1344, { number: 27 }));
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.buffIconDraws).toBe(1);
    expect(diag?.buffIconsRead).toBe(1);

    plugin.close();
  });

  it("reports zero icon draws when the game draws none", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.idle(5);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.buffIconDraws).toBe(0);

    plugin.close();
  });

  /**
   * A BUFF WHOSE TIMER CANNOT BE READ IS STILL A BUFF THAT IS ON.
   *
   * The vendored module answers one question — "read this buff" — and answers it
   * false for five different reasons it does not report, four of which are about
   * the TEXT. Gating presence on the timer parse therefore deleted a lit buff
   * outright: in game, one icon was dropped forty-two times in a single tick and
   * never reached the picker, so it could not be watched for anything at all.
   *
   * The outline box is the module's own test for "this is a buff", so finding it
   * directly is not a looser rule — same exact position, same exact colour.
   */
  it("reads a buff from its outline when the timer cannot be parsed", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 1, verts: 366, x: 1486, y: 990 },
      // The green box the game draws round every buff. No `buff` field, so the
      // module declines this batch exactly as it does in game.
      {
        kind: "render2d",
        images: [{ flat: [90, 150, 25], x: 1486, y: 990, aw: 27, ah: 1 }],
      },
      ...Array.from({ length: 40 }, () => ({ kind: "render2d" as const, images: [{}] })),
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([{ id: "1:366", timeLeft: null, stacks: null }]);
    expect(plugin.latest()?.diag.buffUnpaired).toEqual([]);

    plugin.close();
  });

  /** Red is a debuff, and must not be filed as a buff. */
  it("files an outline-only debuff as a debuff", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 1, verts: 366, x: 1486, y: 990 },
      {
        kind: "render2d",
        images: [{ flat: [204, 0, 0], x: 1486, y: 990, aw: 27, ah: 1 }],
      },
      ...Array.from({ length: 40 }, () => ({ kind: "render2d" as const, images: [{}] })),
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([]);
    expect(plugin.latest()?.debuffs).toEqual([{ id: "1:366", timeLeft: null, stacks: null }]);

    plugin.close();
  });

  /**
   * The outline is matched on EXACT position, like the module's own check. A box
   * one pixel out is a different element, not this buff -- and quietly widening
   * that into a tolerance would be a fresh guessed constant hiding a real
   * mismatch, which is the whole failure mode lua/detect/probe.lua exists for.
   */
  it("does not accept an outline that is not exactly at the icon", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 1, verts: 366, x: 1486, y: 990 },
      {
        kind: "render2d",
        images: [{ flat: [90, 150, 25], x: 1487, y: 990, aw: 27, ah: 1 }],
      },
      ...Array.from({ length: 40 }, () => ({ kind: "render2d" as const, images: [{}] })),
    ]);
    tick(plugin);

    expect(buffs(plugin)).toEqual([]);
    const unpaired = plugin.latest()?.diag.buffUnpaired ?? [];
    expect(unpaired).toHaveLength(1);
    // The message must name the geometry, since text is no longer a candidate.
    expect(unpaired[0]?.err).toBe("no outline box at this position");

    plugin.close();
  });

  /**
   * OUTLINES WITHOUT ICONS ARE THE BLIND SPOT, MEASURED.
   *
   * Bolt raises an icon event only for images it recognised as a rendered 3D item
   * model, so a buff drawn from a plain authored sprite raises none and cannot be
   * detected however well pairing works. Every buff is outlined, so counting
   * boxes against icons is what turns that from an argument into a number.
   */
  it("counts every outline box, including ones no icon event was raised for", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "icon", models: 1, verts: 366, x: 1486, y: 990 },
      { kind: "render2d", images: [1486, 1516, 1546].flatMap((x) => outlineBox(x)) },
    ]);
    tick(plugin);

    // Three buffs are on the bar; only one of them told the plugin it exists.
    expect(plugin.latest()?.diag.buffOutlines).toBe(3);
    expect(plugin.latest()?.diag.buffIconDraws).toBe(1);

    plugin.close();
  });

  /**
   * A BOX IS FOUR QUADS, AND COUNTING QUADS COUNTS EVERY BUFF FOUR TIMES.
   *
   * This shipped wrong: a live bar of six buffs reported twenty-four, and the
   * panel said "24 buffs are on the bar" in words. The geometry here is the real
   * one, read off a 2026-08-07 draw stream: a 27x1 top at the icon's own corner,
   * a 1x25 left one pixel below it, and the matching bottom and right.
   */
  it("counts a four-segment outline as one buff, not four", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "render2d", images: [1456, 1486, 1516, 1546, 1576, 1606].flatMap((x) => outlineBox(x)) },
    ]);
    tick(plugin);

    expect(plugin.latest()?.diag.buffOutlines).toBe(6);

    plugin.close();
  });

  /** Debuff boxes are red and still count as buffs on the bar. */
  it("counts red debuff boxes too", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [...outlineBox(1456), ...outlineBox(1486, [204, 0, 0])],
      },
    ]);
    tick(plugin);

    expect(plugin.latest()?.diag.buffOutlines).toBe(2);

    plugin.close();
  });

  /**
   * ONE ICON THAT NEVER PAIRS IS ONE ENTRY, NOT ONE PER FRAME.
   *
   * The game redraws the buff bar every frame, and each draw pushes its own
   * pending entry, so a single unpairable icon is given up on once per frame.
   * Undeduped, that filled all twelve MAX_UNPAIRED slots by itself: a live panel
   * showed twelve identical lines for what was one icon, and it read as twelve
   * separate failures.
   */
  it("counts one unpairable icon once, with the number of times it was dropped", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      ...Array.from({ length: 4 }, () => ({
        kind: "icon" as const,
        models: 1,
        verts: 366,
        x: 1546,
        y: 990,
      })),
      // Past MAX_TRIES, so every pending copy is given up on rather than carried.
      ...Array.from({ length: 40 }, () => ({ kind: "render2d" as const, images: [{}] })),
    ]);
    tick(plugin);

    const unpaired = plugin.latest()?.diag.buffUnpaired ?? [];
    expect(unpaired).toHaveLength(1);
    expect(unpaired[0]).toMatchObject({ id: "1:366", x: 1546, y: 990, count: 4 });

    plugin.close();
  });

  /**
   * The point of deduping: the list can now show a SECOND failing icon. While one
   * icon could consume every slot, this was unanswerable — and "which of them are
   * failing" is the only question the list exists to answer.
   */
  it("shows every distinct icon that failed, not just the first", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      ...Array.from({ length: 6 }, () => ({
        kind: "icon" as const,
        models: 1,
        verts: 366,
        x: 1546,
        y: 990,
      })),
      ...Array.from({ length: 6 }, () => ({
        kind: "icon" as const,
        models: 2,
        verts: 1239,
        x: 1486,
        y: 990,
      })),
      ...Array.from({ length: 40 }, () => ({ kind: "render2d" as const, images: [{}] })),
    ]);
    tick(plugin);

    const unpaired = plugin.latest()?.diag.buffUnpaired ?? [];
    expect(unpaired.map((u) => u.id).sort()).toEqual(["1:366", "2:1239"]);

    plugin.close();
  });

  /**
   * COVERS THE FAKE HOST, NOT THE PLUGIN, and it earns its place.
   *
   * Sprite identity hashes pixels sampled across an icon. If the fake answered
   * texturedata identically at every point — which it did — then sixty-four
   * samples would read one value sixty-four times, every sprite would hash
   * alike, and an identity test would pass just as happily against an
   * implementation that never read a texture at all.
   */
  it("reads different bytes at different points of one texture", async () => {
    const plugin = await loadPlugin();

    plugin.frame([
      {
        kind: "render2d",
        images: [{ ax: 0, ay: 0, aw: 4, ah: 4, x: 0, y: 0, texture: "ABCDEFGHIJKLMNOP" }],
      },
    ]);

    const a = plugin.eval(`return driver.lastevent:texturedata(0, 0, 4)`);
    const b = plugin.eval(`return driver.lastevent:texturedata(1, 0, 4)`);
    expect(a).toBe("ABCD");
    expect(b).toBe("EFGH");

    plugin.close();
  });
});
