import { describe, expect, it } from "vitest";
import { inactiveAlerter } from "~/alerters/inactive";
import type { AlerterContext } from "~/engine/types";
import { NO_STATE } from "~/engine/types";

function ctx(over: Partial<AlerterContext> = {}): AlerterContext {
  return {
    tick: 1,
    now: 1_700_000_000_000,
    // Milliseconds SINCE the last click -- a duration, not a timestamp.
    idleMs: 0,
    mouseIdleMs: 0,
    connected: true,
    chatLines: [],
    chatAvailable: true,
    state: NO_STATE,
    ...over,
  };
}

describe("inactiveAlerter", () => {
  it("defaults to AfkWarden's lobby timer delay", () => {
    expect(inactiveAlerter.schema.parse({}).delay).toBe(570);
  });

  it("rejects a non-positive delay", () => {
    expect(() => inactiveAlerter.schema.parse({ delay: 0 })).toThrow();
    expect(() => inactiveAlerter.schema.parse({ delay: -5 })).toThrow();
  });

  // The regression: idleMs was previously treated as an epoch timestamp and
  // subtracted from Date.now(), producing ~1.7e12 ms of "idle" on every tick, so
  // the lobby timer sat permanently triggered and never counted down.
  it("is not triggered immediately after a click", () => {
    const a = inactiveAlerter.create({ delay: 570, countMouseMovement: false });
    const r = a.check(ctx({ idleMs: 0 }));
    expect(r.triggered).toBe(false);
    expect(r.bar).toBe(0);
  });

  it("counts up proportionally toward the delay", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    expect(a.check(ctx({ idleMs: 2_500 })).bar).toBeCloseTo(0.25);
    expect(a.check(ctx({ idleMs: 5_000 })).bar).toBeCloseTo(0.5);
    expect(a.check(ctx({ idleMs: 9_000 })).bar).toBeCloseTo(0.9);
  });

  it("does not trigger before the delay", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    expect(a.check(ctx({ idleMs: 9_999 })).triggered).toBe(false);
  });

  it("triggers at the delay", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    expect(a.check(ctx({ idleMs: 10_000 })).triggered).toBe(true);
  });

  it("clamps the bar at 1 once well past the delay", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    const r = a.check(ctx({ idleMs: 999_000 }));
    expect(r.triggered).toBe(true);
    expect(r.bar).toBe(1);
  });

  it("un-triggers when the player clicks again", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    expect(a.check(ctx({ idleMs: 20_000 })).triggered).toBe(true);
    expect(a.check(ctx({ idleMs: 0 })).triggered).toBe(false);
  });

  // rsLastActive needs the Gamestate permission. Without it the value is
  // meaningless, and reporting "fine" would be a silent permanent failure.
  it("reports non-functional without the gamestate permission", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    const r = a.check(ctx({ idleMs: 20_000, connected: false }));
    expect(r.functional).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it("is functional when gamestate is available", () => {
    expect(inactiveAlerter.create({ delay: 10, countMouseMovement: false }).check(ctx()).functional).toBe(true);
  });
});

describe("inactiveAlerter with countMouseMovement", () => {
  it("defaults to off", () => {
    expect(inactiveAlerter.schema.parse({}).countMouseMovement).toBe(false);
  });

  // The conservative default: RuneScape counts hovering as activity, but assuming
  // so wrongly would warn late, which is the one failure this alert must not have.
  it("ignores mouse movement when off", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: false });
    expect(a.check(ctx({ idleMs: 20_000, mouseIdleMs: 0 })).triggered).toBe(true);
  });

  it("treats recent mouse movement as activity when on", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: true });
    // No click for 20s, but the cursor moved a moment ago.
    expect(a.check(ctx({ idleMs: 20_000, mouseIdleMs: 500 })).triggered).toBe(false);
  });

  it("still triggers when both the mouse and clicks have gone quiet", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: true });
    expect(a.check(ctx({ idleMs: 20_000, mouseIdleMs: 15_000 })).triggered).toBe(true);
  });

  it("uses whichever activity was more recent for the bar", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: true });
    // Clicked 9s ago, moved 2.5s ago -> 25% of the way to the threshold.
    expect(a.check(ctx({ idleMs: 9_000, mouseIdleMs: 2_500 })).bar).toBeCloseTo(0.25);
  });

  it("still respects a recent click when the mouse has been still", () => {
    const a = inactiveAlerter.create({ delay: 10, countMouseMovement: true });
    expect(a.check(ctx({ idleMs: 1_000, mouseIdleMs: 60_000 })).triggered).toBe(false);
  });
});
