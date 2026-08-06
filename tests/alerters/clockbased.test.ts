import { describe, expect, it } from "vitest";
import { clockBasedAlerter, clockWindow } from "~/alerters/clockbased";
import type { AlerterContext } from "~/engine/types";
import { NO_STATE } from "~/engine/types";

const HOUR = 60 * 60 * 1000;
/** An exact epoch hour boundary, when the event starts. */
const ON_THE_HOUR = 1_700_000 * HOUR;

function ctx(now: number): AlerterContext {
  return {
    tick: 1,
    now,
    idleMs: 0,
    mouseIdleMs: 0,
    connected: true,
    chatLines: [],
    chatAvailable: true,
    state: NO_STATE,
  };
}

describe("clockWindow with no warning", () => {
  it("is open right on the hour", () => {
    expect(clockWindow(ON_THE_HOUR, "wfe", 0).triggered).toBe(true);
  });

  it("stays open through the event", () => {
    expect(clockWindow(ON_THE_HOUR + 4 * 60_000, "wfe", 0).triggered).toBe(true);
  });

  it("closes once the event ends", () => {
    expect(clockWindow(ON_THE_HOUR + 5 * 60_000, "wfe", 0).triggered).toBe(false);
    expect(clockWindow(ON_THE_HOUR + 30 * 60_000, "wfe", 0).triggered).toBe(false);
  });

  it("is closed just before the hour", () => {
    expect(clockWindow(ON_THE_HOUR - 1_000, "wfe", 0).triggered).toBe(false);
  });

  it("reports the time until the next event", () => {
    const w = clockWindow(ON_THE_HOUR + 20 * 60_000, "wfe", 0);
    expect(w.untilNextMs).toBe(40 * 60_000);
  });

  it("repeats every hour", () => {
    expect(clockWindow(ON_THE_HOUR + HOUR, "wfe", 0).triggered).toBe(true);
    expect(clockWindow(ON_THE_HOUR + 5 * HOUR, "wfe", 0).triggered).toBe(true);
  });
});

describe("clockWindow with a warning offset", () => {
  it("opens early by the configured amount", () => {
    expect(clockWindow(ON_THE_HOUR - 45_000, "wfe", 60).triggered).toBe(true);
    expect(clockWindow(ON_THE_HOUR - 90_000, "wfe", 60).triggered).toBe(false);
  });

  // Warning early must not cut the event short at the other end.
  it("still covers the whole event", () => {
    expect(clockWindow(ON_THE_HOUR + 4 * 60_000, "wfe", 60).triggered).toBe(true);
    expect(clockWindow(ON_THE_HOUR + 5 * 60_000, "wfe", 60).triggered).toBe(false);
  });

  it("can be delayed with a negative offset", () => {
    expect(clockWindow(ON_THE_HOUR + 10_000, "wfe", -30).triggered).toBe(false);
    expect(clockWindow(ON_THE_HOUR + 40_000, "wfe", -30).triggered).toBe(true);
  });
});

describe("clockBasedAlerter", () => {
  it("defaults to wilderness flash events with no warning", () => {
    expect(clockBasedAlerter.schema.parse({})).toEqual({ mode: "wfe", offset: 0 });
  });

  it("rejects an offset outside the allowed range", () => {
    expect(() => clockBasedAlerter.schema.parse({ offset: 601 })).toThrow();
    expect(() => clockBasedAlerter.schema.parse({ offset: -61 })).toThrow();
  });

  it("needs no reader, so it is always functional", () => {
    const a = clockBasedAlerter.create({ mode: "wfe", offset: 0 });
    expect(a.check(ctx(ON_THE_HOUR + 30 * 60_000)).functional).toBe(true);
  });

  it("fires during the event", () => {
    const a = clockBasedAlerter.create({ mode: "wfe", offset: 0 });
    const r = a.check(ctx(ON_THE_HOUR + 60_000));
    expect(r.triggered).toBe(true);
    expect(r.bar).toBe(1);
  });

  // AfkWarden leaves the bar at zero until it fires; counting down is more use.
  it("counts the bar down toward the next event", () => {
    const a = clockBasedAlerter.create({ mode: "wfe", offset: 0 });
    const early = a.check(ctx(ON_THE_HOUR + 10 * 60_000)).bar;
    const later = a.check(ctx(ON_THE_HOUR + 50 * 60_000)).bar;
    expect(later).toBeGreaterThan(early);
    expect(later).toBeLessThan(1);
  });

  it("tracks Guthixian caches on the same cadence", () => {
    const a = clockBasedAlerter.create({ mode: "divcache", offset: 0 });
    expect(a.check(ctx(ON_THE_HOUR)).triggered).toBe(true);
    expect(a.check(ctx(ON_THE_HOUR + 30 * 60_000)).triggered).toBe(false);
  });
});
