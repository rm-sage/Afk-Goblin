import { describe, expect, it } from "vitest";
import { actionbarAlerter } from "~/alerters/actionbar";
import type { AlerterContext } from "~/engine/types";
import { NO_STATE, type Stats as ActionbarState } from "~/engine/types";

function ctx(bar: ActionbarState | null, over: Partial<AlerterContext> = {}): AlerterContext {
  return {
    tick: 1,
    now: 0,
    idleMs: 0,
    mouseIdleMs: 0,
    connected: true,
    chatLines: [],
    chatAvailable: true,
    state: { ...NO_STATE, stats: bar },
    ...over,
  };
}

const full: ActionbarState = { hp: 1, pray: 1, sum: 1, dren: 0 };

describe("actionbarAlerter schema", () => {
  it("defaults to the HP-below-20% alert AfkWarden ships", () => {
    const v = actionbarAlerter.schema.parse({});
    expect(v).toEqual({ stat: "hp", higherlower: "lower", threshold: 20 });
  });

  it("rejects an out-of-range threshold", () => {
    expect(() => actionbarAlerter.schema.parse({ threshold: 101 })).toThrow();
    expect(() => actionbarAlerter.schema.parse({ threshold: -1 })).toThrow();
  });

  it("rejects an unknown stat", () => {
    expect(() => actionbarAlerter.schema.parse({ stat: "wc" })).toThrow();
  });
});

describe("actionbarAlerter lower", () => {
  const a = () => actionbarAlerter.create({ stat: "hp", higherlower: "lower", threshold: 30 });

  it("does not trigger above the threshold", () => {
    expect(a().check(ctx({ ...full, hp: 0.5 })).triggered).toBe(false);
  });

  it("triggers below the threshold", () => {
    expect(a().check(ctx({ ...full, hp: 0.2 })).triggered).toBe(true);
  });

  it("triggers exactly at the threshold", () => {
    expect(a().check(ctx({ ...full, hp: 0.3 })).triggered).toBe(true);
  });

  // The bar tracks progress toward firing, so it fills as the resource drains.
  it("fills the bar as the resource drains", () => {
    expect(a().check(ctx({ ...full, hp: 1 })).bar).toBe(0);
    expect(a().check(ctx({ ...full, hp: 0.25 })).bar).toBeCloseTo(0.75);
  });
});

describe("actionbarAlerter higher", () => {
  const a = () => actionbarAlerter.create({ stat: "dren", higherlower: "higher", threshold: 50 });

  it("triggers at or above the threshold", () => {
    expect(a().check(ctx({ ...full, dren: 0.5 })).triggered).toBe(true);
    expect(a().check(ctx({ ...full, dren: 0.9 })).triggered).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    expect(a().check(ctx({ ...full, dren: 0.4 })).triggered).toBe(false);
  });

  it("fills the bar as the resource rises", () => {
    expect(a().check(ctx({ ...full, dren: 0.25 })).bar).toBeCloseTo(0.5);
    expect(a().check(ctx({ ...full, dren: 0.9 })).bar).toBe(1);
  });

  it("does not divide by zero at a zero threshold", () => {
    const z = actionbarAlerter.create({ stat: "dren", higherlower: "higher", threshold: 0 });
    const r = z.check(ctx({ ...full, dren: 0 }));
    expect(r.bar).toBe(1);
    expect(Number.isFinite(r.bar)).toBe(true);
  });
});

describe("actionbarAlerter reader state", () => {
  // Reporting "your HP is fine" when the bar cannot be seen is the silent failure
  // this project exists to remove.
  it("reports non-functional when the action bar is not found", () => {
    const a = actionbarAlerter.create({ stat: "hp", higherlower: "lower", threshold: 30 });
    const r = a.check(ctx(null));
    expect(r.functional).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it("reads each stat independently", () => {
    const state: ActionbarState = { hp: 0.9, pray: 0.1, sum: 0.5, dren: 0.2 };
    const pray = actionbarAlerter.create({ stat: "pray", higherlower: "lower", threshold: 20 });
    const hp = actionbarAlerter.create({ stat: "hp", higherlower: "lower", threshold: 20 });
    expect(pray.check(ctx(state)).triggered).toBe(true);
    expect(hp.check(ctx(state)).triggered).toBe(false);
  });
});
