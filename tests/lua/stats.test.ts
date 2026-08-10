import { describe, expect, it } from "vitest";
import { bar, BAR_COLOURS, loadPlugin, TICK_US, type LuaPlugin } from "./harness";

/**
 * Action-bar resource levels.
 *
 * lua/detect/stats.lua carries a comment saying it has never been verified
 * against a live client, and its geometry — which vertex is the far edge, what a
 * full bar measures — was written from observation rather than from a reading.
 * These tests pin the arithmetic, which is the half that can be checked without
 * the game. They cannot confirm the constants are the right ones; only the game
 * can do that.
 */

function tick(plugin: LuaPlugin): void {
  plugin.frame([], TICK_US);
}

function stats(plugin: LuaPlugin): Record<string, number> | null {
  return (plugin.latest()?.stats ?? null) as Record<string, number> | null;
}

describe("action bar levels", () => {
  /**
   * Null and all-zero mean opposite things: one is "cannot see the action bar",
   * the other is "you are about to die". Alerters key life-or-death behaviour
   * off the difference.
   */
  it("reports null until a bar has been seen", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.idle(3);
    tick(plugin);

    expect(stats(plugin)).toBeNull();

    plugin.close();
  });

  it("reads a full bar as 1 and an empty one as 0", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: [bar("hp", 1)] }]);
    tick(plugin);
    expect(stats(plugin)?.hp).toBeCloseTo(1, 5);

    plugin.frame([{ kind: "render2d", images: [bar("hp", 0)] }]);
    tick(plugin);
    expect(stats(plugin)?.hp).toBeCloseTo(0, 5);

    plugin.close();
  });

  it("reads a part-full bar as its fraction", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: [bar("hp", 0.5)] }]);
    tick(plugin);

    expect(stats(plugin)?.hp).toBeCloseTo(0.5, 5);

    plugin.close();
  });

  it("tells the four bars apart by colour", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [bar("hp", 0.8, 0), bar("pray", 0.6, 1), bar("sum", 0.4, 2), bar("dren", 0.2, 3)],
      },
    ]);
    tick(plugin);

    const s = stats(plugin);
    expect(s?.hp).toBeCloseTo(0.8, 5);
    expect(s?.pray).toBeCloseTo(0.6, 5);
    expect(s?.sum).toBeCloseTo(0.4, 5);
    expect(s?.dren).toBeCloseTo(0.2, 5);

    plugin.close();
  });

  /**
   * AN UNREAD BAR IS NULL, NOT A HARMLESS DEFAULT — and the harmless default was
   * a silent missed alert. This used to fill them in with full health, prayer and
   * summoning and no adrenaline, on the reasoning that a zero would fire every
   * low-health alert the moment a bar was hidden.
   *
   * The reasoning was right about zero and wrong about the alternative. On a
   * client where the health bar's hue never clears the saturation gate while
   * another bar does, "full health" was published from the first tick onward for
   * the whole session, with functional:true — so an "HP at or below 25%" alert
   * could never fire and never said why, while barsRead quietly read 1.
   *
   * Null is the third option: not a panic, not a lie. `actionbar` turns it into no
   * data for that specific stat.
   */
  it("reports an unread bar as null rather than substituting a value", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: [bar("hp", 0.3)] }]);
    tick(plugin);

    const s = stats(plugin);
    expect(s?.hp).toBeCloseTo(0.3, 5);
    expect(s?.pray).toBeNull();
    expect(s?.sum).toBeNull();
    expect(s?.dren).toBeNull();

    plugin.close();
  });

  /**
   * A reading must not outlive the thing it read. `levels` used to persist for the
   * whole session, so the last-known fractions kept being published as current the
   * moment the action bar went off screen — a cutscene, a full-screen interface, a
   * hidden HUD.
   */
  it("stops reporting a bar once it is no longer drawn", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: [bar("hp", 0.3)] }]);
    tick(plugin);
    expect(stats(plugin)?.hp).toBeCloseTo(0.3, 5);

    // The action bar is gone.
    plugin.idle(3);
    tick(plugin);

    expect(stats(plugin)).toBeNull();

    plugin.close();
  });

  /**
   * The vertex-colour fallback, for a client that draws the bars as one shared
   * neutral sprite tinted per bar.
   *
   * NOT WHAT THE REAL CLIENT DOES — a 2026-08-07 reading showed the texture
   * carrying the colour and the tint plain white, the opposite of what this file
   * and stats.lua both used to assert. Kept as a fallback test rather than
   * deleted, because the fallback is still in the code; it is no longer labelled
   * as the live path.
   */
  it("identifies a bar drawn as a tinted sprite", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          { ...bar("hp", 0.5), rgb: [0xc8, 0xc8, 0xc8], tint: [...BAR_COLOURS.hp] },
          { ...bar("pray", 0.25, 1), rgb: [0xc8, 0xc8, 0xc8], tint: [...BAR_COLOURS.pray] },
        ],
      },
    ]);
    tick(plugin);

    expect(stats(plugin)?.hp).toBeCloseTo(0.5, 5);
    expect(stats(plugin)?.pray).toBeCloseTo(0.25, 5);
    expect(plugin.latest()?.diag.barsRead).toBe(2);

    plugin.close();
  });

  /** A pre-coloured sprite must keep working; the texture is still checked first. */
  it("still identifies a bar coloured in its own texture", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: [bar("sum", 0.75)] }]);
    tick(plugin);

    expect(stats(plugin)?.sum).toBeCloseTo(0.75, 5);

    plugin.close();
  });

  it("ignores a 106x4 image that is not one of the four bars", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "render2d", images: [{ ax: 0, ay: 0, aw: 106, ah: 4, x: 10, y: 500, rgb: [1, 2, 3] }] },
    ]);
    tick(plugin);

    expect(stats(plugin)).toBeNull();

    plugin.close();
  });

  /**
   * THE HAZARD THE HUE MATCH BRINGS WITH IT, PINNED DOWN.
   *
   * Hue is meaningless for a grey, and the standard conversion reports it as 0
   * degrees — which is 14 degrees from health and inside the tolerance. Every
   * bar in the live reading carries a plain #ffffff vertex tint, and `identify`
   * falls back to reading that tint, so without a saturation floor the fallback
   * would report a full health bar for any white or grey quad that happened to
   * be 106x4. That is the failure the old RGB match could not have had, so it
   * gets a test rather than a comment.
   */
  it("never mistakes a white or grey 106x4 image for the health bar", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          { ax: 0, ay: 0, aw: 106, ah: 4, x: 10, y: 500, rgb: [0xff, 0xff, 0xff] },
          { ax: 0, ay: 4, aw: 106, ah: 4, x: 10, y: 520, rgb: [0xc8, 0xc8, 0xc8] },
          { ax: 0, ay: 8, aw: 106, ah: 4, x: 10, y: 540, rgb: [0x80, 0x80, 0x80] },
        ],
      },
    ]);
    tick(plugin);

    expect(stats(plugin)).toBeNull();
    expect(plugin.latest()?.diag.barsRead).toBe(0);

    plugin.close();
  });

  /**
   * The whole point of matching on hue: the four bars stay identifiable when the
   * palette drifts in brightness. These are the measured colours pushed a long
   * way darker and paler — far outside the old per-channel tolerance of 12,
   * which is what failed in game — while their hues are untouched.
   */
  it("still identifies bars whose brightness has drifted", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          { ...bar("hp", 0.5, 0), rgb: [0xb4, 0x55, 0x39] },
          { ...bar("sum", 0.5, 1), rgb: [0x5c, 0xd8, 0xcd] },
        ],
      },
    ]);
    tick(plugin);

    expect(stats(plugin)?.hp).toBeCloseTo(0.5, 5);
    expect(stats(plugin)?.sum).toBeCloseTo(0.5, 5);

    plugin.close();
  });

  /**
   * Nothing promises the four bars share a render2d batch. Closing the scan on
   * the first bar identified means any bar drawn in a later batch is never read
   * at all — it holds its safe default forever, so a prayer alert stays silent
   * while prayer drains. Silent and permanent, which is the worst shape a
   * failure can take in this app.
   */
  /**
   * The action bar used the same scan window chat did, so it was blind for the
   * same reason: Bolt raises onswapbuffers per buffer swap, not per frame, and a
   * window closed on the next swap can close before any render2d arrives. Health
   * would then read as permanently full, which is the most dangerous possible
   * direction for this particular reading to fail in.
   */
  it("reads bars when the client swaps buffers more than once per frame", async () => {
    const plugin = await loadPlugin();
    plugin.setSwapsPerFrame(2);

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: [bar("hp", 0.25)] }]);
    tick(plugin);

    expect(stats(plugin)?.hp).toBeCloseTo(0.25, 5);
    expect(plugin.latest()?.diag.barsRead).toBe(1);

    plugin.close();
  });

  it("reads bars split across separate batches", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "render2d", images: [bar("hp", 0.9, 0)] },
      { kind: "render2d", images: [bar("pray", 0.5, 1)] },
    ]);
    tick(plugin);

    expect(stats(plugin)?.hp).toBeCloseTo(0.9, 5);
    expect(stats(plugin)?.pray).toBeCloseTo(0.5, 5);

    plugin.close();
  });
});
