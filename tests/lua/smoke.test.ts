import { describe, expect, it } from "vitest";
import { loadPlugin, TICK_US } from "./harness";

/**
 * Proves the harness itself works before anything is asserted through it.
 *
 * A test suite that boots a VM can fail for reasons that have nothing to do with
 * the code under test — a file not mounted, a require not resolving, a fake host
 * missing a function main.lua calls at startup. These are the tests that say
 * which of those it is.
 */
function tick(plugin: Awaited<ReturnType<typeof loadPlugin>>): void {
  plugin.frame([], TICK_US);
}

describe("lua harness", () => {
  it("boots main.lua and completes the startup handshake", async () => {
    const plugin = await loadPlugin();

    const hello = plugin.sent().find((m) => m.t === "hello");
    expect(hello).toBeDefined();
    expect(hello?.apiVersion).toEqual([1, 0]);

    plugin.close();
  });

  it("sends no snapshot until a full tick has passed", async () => {
    const plugin = await loadPlugin();

    plugin.idle(5);
    expect(plugin.states()).toHaveLength(0);

    plugin.frame([], TICK_US);
    expect(plugin.states()).toHaveLength(1);

    plugin.close();
  });

  it("reports the character name, never the id", async () => {
    const plugin = await loadPlugin();
    plugin.frame([], TICK_US);

    const state = plugin.latest();
    expect(state?.characterName).toBe("Sage");
    expect(state?.loggedIn).toBe(true);
    expect(JSON.stringify(state)).not.toContain("character-hash");

    plugin.close();
  });

  /**
   * The single number that separates "detection looked and found nothing" from
   * "detection never got to look". Every other count is ambiguous without it —
   * which is precisely how a scan window that never opened looked like an empty
   * screen for two sessions running.
   */
  it("reports how many render2d events detection was fed", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      { kind: "render2d", images: [{ aw: 4, ah: 4, x: 1, y: 1 }] },
      { kind: "render2d", images: [{ aw: 4, ah: 4, x: 2, y: 2 }] },
    ]);
    plugin.frame([{ kind: "render2d", images: [{ aw: 4, ah: 4, x: 3, y: 3 }] }]);
    tick(plugin);

    expect(plugin.latest()?.diag.render2dEvents).toBe(3);

    plugin.close();
  });

  it("reports zero render2d events when the game draws nothing", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.idle(4);
    tick(plugin);

    expect(plugin.latest()?.diag.render2dEvents).toBe(0);

    plugin.close();
  });

  it("routes a close request from the UI through to bolt.close", async () => {
    const plugin = await loadPlugin();

    expect(plugin.driver("closed")).toBe(false);
    plugin.eval(`driver.requestclose()`);
    expect(plugin.driver("closed")).toBe(true);

    plugin.close();
  });

  it("persists the config blob the UI sends", async () => {
    const plugin = await loadPlugin();

    plugin.fromUi(`{"t":"save","data":"{\\"presets\\":[]}"}`);

    expect(plugin.eval(`return driver.storedconfig["character-hash.json"]`)).toBe(`{"presets":[]}`);

    plugin.close();
  });

  /**
   * A CLOCK WRAP USED TO READ AS "YOU JUST CLICKED", FOREVER.
   *
   * bolt.time() is monotonic microseconds from an arbitrary origin and wraps
   * roughly hourly on a 32-bit host — main.lua already treats that as live for its
   * tick gate. The activity anchors are only rewritten by a real input event, so
   * after a wrap `elapsedms` clamped a negative delta to zero and every snapshot
   * reported clickIdleMs = 0 until the player physically clicked.
   *
   * The browser re-anchors on that each tick, so idleMs never exceeded one tick: an
   * inactive alert set to nine minutes could NEVER fire and the player is logged out
   * with no warning. With activeSuppress on it is worse — a stuck zero reads as
   * "playing" and silences every alarm.
   */
  it("keeps measuring idle time after the game clock wraps", async () => {
    const plugin = await loadPlugin();

    plugin.idle(4, TICK_US);
    const before = plugin.latest()?.clickIdleMs ?? 0;
    expect(before).toBeGreaterThan(0);

    // The wrap: the clock restarts behind the anchors, leaving them in the future.
    plugin.eval(`driver.time = 0`);
    plugin.idle(1, TICK_US);

    // Several ticks later idle time must be growing again rather than stuck at 0.
    plugin.idle(3, TICK_US);
    const after = plugin.latest()?.clickIdleMs ?? -1;
    expect(after).toBeGreaterThan(0);

    plugin.idle(3, TICK_US);
    expect(plugin.latest()?.clickIdleMs ?? -1).toBeGreaterThan(after);

    plugin.close();
  });
});