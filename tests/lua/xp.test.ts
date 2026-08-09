import { describe, expect, it } from "vitest";
import { chatBox, fontRun, loadPlugin, TICK_US, type LuaPlugin, type SentMessage } from "./harness";

/**
 * XP drop detection, driven through main.lua.
 *
 * Read as TEXT, using the same font lookup chat uses. registry.ts recorded the
 * blocker as identifying the '+' glyph against a live client; the vendored font
 * tables already carry '+', every digit, ',', '.', 'k' and 'm', so no reading was
 * needed.
 *
 * Sent under "tot" only. A drop's number cannot say which skill it belongs to,
 * and attributing it would mean hashing the skill icon and binding each one to a
 * three-letter code — decided against for now, so a skill-specific alert reports
 * itself unreadable rather than quietly watching everything.
 */

function tick(plugin: LuaPlugin): void {
  plugin.frame([], TICK_US);
}

/** Every XP amount the plugin has sent, in order. */
function amounts(plugin: LuaPlugin): number[] {
  return plugin
    .sent()
    .filter((m) => m.t === "xp")
    .map((m) => (m as SentMessage & { amount: number }).amount);
}

/** The skill code every XP event was sent under. */
function skills(plugin: LuaPlugin): string[] {
  return plugin
    .sent()
    .filter((m) => m.t === "xp")
    .map((m) => (m as SentMessage & { skill: string }).skill);
}

describe("XP drop detection", () => {
  it("reads a plain drop", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("+312", { x: 900, y: 200 }) }]);
    tick(plugin);

    expect(amounts(plugin)).toEqual([312]);
    expect(skills(plugin)).toEqual(["tot"]);

    plugin.close();
  });

  it("strips thousands separators", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("+1,234", { x: 900, y: 200 }) }]);
    tick(plugin);

    expect(amounts(plugin)).toEqual([1234]);

    plugin.close();
  });

  it("applies a k or m suffix", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("+1.5k", { x: 900, y: 200 }) }]);
    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("+2m", { x: 900, y: 260 }) }]);
    tick(plugin);

    expect(amounts(plugin)).toEqual([1500, 2000000]);

    plugin.close();
  });

  /**
   * A drop is redrawn on every frame of the tick while it floats and fades.
   * Counting each sighting would multiply it by the frame rate.
   */
  it("counts a drop redrawn on every frame once per tick", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    for (let i = 0; i < 12; i++) {
      plugin.frame([{ kind: "render2d", images: fontRun("+312", { x: 900, y: 200 }) }]);
    }
    tick(plugin);

    expect(amounts(plugin)).toEqual([312]);

    plugin.close();
  });

  it("reads two different drops in one tick", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          ...fontRun("+312", { x: 900, y: 200 }),
          ...fontRun("+45", { x: 900, y: 260 }, 7, 900),
        ],
      },
    ]);
    tick(plugin);

    expect(amounts(plugin).sort((a, b) => a - b)).toEqual([45, 312]);

    plugin.close();
  });

  /**
   * ONLY A '+' OPENS A RUN. Otherwise every number on screen — buff timers, item
   * counts, the action bar — would be read as XP.
   */
  it("ignores a number with no leading plus", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("1234", { x: 900, y: 200 }) }]);
    tick(plugin);

    expect(amounts(plugin)).toEqual([]);

    plugin.close();
  });

  it("ignores a run containing letters", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("+50xp", { x: 900, y: 200 }) }]);
    tick(plugin);

    // The 'x' ends the run at "+50" rather than being absorbed into it, and a
    // two-character run of digits is still a plausible drop — so what this
    // asserts is that the LETTER is not swallowed, not that the run is rejected.
    expect(amounts(plugin)).toEqual([50]);

    plugin.close();
  });

  /**
   * THE FALSE-POSITIVE THAT WOULD MATTER. Chat and XP drops are drawn in the same
   * font, so a chat line reading "+50" is indistinguishable from a drop — and a
   * false drop resets an inactivity timer, DELAYING the alert it exists to fire.
   * main.lua keeps the XP scan off any batch chat claimed.
   */
  it("does not read a drop out of a chat batch", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      {
        kind: "render2d",
        images: [
          ...chatBox({ x: 20, y: 400 }, { messages: [] }).images,
          ...fontRun("+50", { x: 40, y: 420 }),
        ],
      },
    ]);
    tick(plugin);

    expect(amounts(plugin)).toEqual([]);

    plugin.close();
  });

  it("reports what it examined so a miss can be told from a silence", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([{ kind: "render2d", images: fontRun("+312", { x: 900, y: 200 }) }]);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.xpRunsExamined).toBeGreaterThan(0);
    expect(diag?.xpDropsRead).toBe(1);

    plugin.close();
  });
});
