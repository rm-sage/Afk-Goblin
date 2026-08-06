import { describe, expect, it } from "vitest";
import { bigXpAlerter, skillAliases, xpCounterAlerter } from "~/alerters/xpcounter";
import type { AlerterContext } from "~/engine/types";
import { NO_STATE } from "~/engine/types";

function ctx(
  xp: Record<string, number>,
  now = 0,
  over: Partial<AlerterContext> = {},
): AlerterContext {
  return {
    tick: 1,
    now,
    idleMs: 0,
    mouseIdleMs: 0,
    connected: true,
    chatLines: [],
    chatAvailable: true,
    state: { ...NO_STATE, xp },
    ...over,
  };
}

describe("skillAliases", () => {
  // AfkWarden's dropdown stores "tot" while its own premades ship "total".
  it("treats tot and total as the same skill", () => {
    expect(skillAliases("tot")).toEqual(["tot", "total"]);
    expect(skillAliases("total")).toEqual(["tot", "total"]);
  });

  it("leaves other codes alone", () => {
    expect(skillAliases("div")).toEqual(["div"]);
  });
});

describe("xpCounterAlerter", () => {
  const vars = { delay: 5, threshold: 0, skill: "div" };

  it("defaults match AfkWarden", () => {
    expect(xpCounterAlerter.schema.parse({})).toEqual({ delay: 5, threshold: 0, skill: "tot" });
  });

  it("is non-functional when the XP counter cannot be read", () => {
    const a = xpCounterAlerter.create(vars);
    expect(a.check(ctx({}, 0)).functional).toBe(false);
  });

  it("does not trigger immediately on the first reading", () => {
    const a = xpCounterAlerter.create(vars);
    expect(a.check(ctx({ div: 5000 }, 0)).triggered).toBe(false);
  });

  it("triggers after the delay with no XP gain", () => {
    const a = xpCounterAlerter.create(vars);
    a.check(ctx({ div: 5000 }, 0));
    expect(a.check(ctx({ div: 5000 }, 4_000)).triggered).toBe(false);
    expect(a.check(ctx({ div: 5000 }, 5_000)).triggered).toBe(true);
  });

  it("resets when XP is gained", () => {
    const a = xpCounterAlerter.create(vars);
    a.check(ctx({ div: 5000 }, 0));
    a.check(ctx({ div: 5000 }, 4_000));
    a.check(ctx({ div: 5100 }, 4_500));
    expect(a.check(ctx({ div: 5100 }, 8_000)).triggered).toBe(false);
    expect(a.check(ctx({ div: 5100 }, 9_500)).triggered).toBe(true);
  });

  it("ignores gains below the threshold", () => {
    const a = xpCounterAlerter.create({ delay: 5, threshold: 50, skill: "div" });
    a.check(ctx({ div: 5000 }, 0));
    // +10 is under the 50 threshold, so it does not count as activity.
    a.check(ctx({ div: 5010 }, 2_000));
    expect(a.check(ctx({ div: 5010 }, 5_000)).triggered).toBe(true);
  });

  it("fills the bar toward the delay", () => {
    const a = xpCounterAlerter.create(vars);
    a.check(ctx({ div: 5000 }, 0));
    expect(a.check(ctx({ div: 5000 }, 2_500)).bar).toBeCloseTo(0.5);
  });

  it("resolves the total skill under either code", () => {
    const a = xpCounterAlerter.create({ delay: 5, threshold: 0, skill: "total" });
    expect(a.check(ctx({ tot: 999 }, 0)).functional).toBe(true);
  });
});

describe("bigXpAlerter", () => {
  const vars = { threshold: 1000, skill: "con" };

  it("defaults match AfkWarden", () => {
    expect(bigXpAlerter.schema.parse({})).toEqual({ threshold: 1000, skill: "tot" });
  });

  it("is non-functional when the XP counter cannot be read", () => {
    expect(bigXpAlerter.create(vars).check(ctx({}, 0)).functional).toBe(false);
  });

  it("does not trigger on the first reading", () => {
    expect(bigXpAlerter.create(vars).check(ctx({ con: 50_000 }, 0)).triggered).toBe(false);
  });

  it("does not trigger on a small gain", () => {
    const a = bigXpAlerter.create(vars);
    a.check(ctx({ con: 50_000 }, 0));
    expect(a.check(ctx({ con: 50_500 }, 1_000)).triggered).toBe(false);
  });

  it("triggers on a gain above the threshold", () => {
    const a = bigXpAlerter.create(vars);
    a.check(ctx({ con: 50_000 }, 0));
    // Idle throughout, so the drop postdates the last click.
    expect(a.check(ctx({ con: 60_000 }, 1_000, { idleMs: 60_000 })).triggered).toBe(true);
  });

  // The alert says "something finished"; acting on it is what clears it.
  it("clears once the player clicks after the drop", () => {
    const a = bigXpAlerter.create(vars);
    a.check(ctx({ con: 50_000 }, 0, { idleMs: 60_000 }));
    expect(a.check(ctx({ con: 60_000 }, 1_000, { idleMs: 60_000 })).triggered).toBe(true);
    // Clicked 100ms ago, well after the drop at t=1000.
    expect(a.check(ctx({ con: 60_000 }, 5_000, { idleMs: 100 })).triggered).toBe(false);
  });
});
