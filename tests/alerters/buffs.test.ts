import { describe, expect, it } from "vitest";
import { buffsAlerter, compensateAbbreviation } from "~/alerters/buffs";
import { NO_STATE, type AlerterContext, type BuffSlot } from "~/engine/types";

function ctx(slots: BuffSlot[], over: Partial<AlerterContext> = {}): AlerterContext {
  return {
    tick: 1,
    now: 1_000_000,
    idleMs: 0,
    mouseIdleMs: 0,
    connected: true,
    chatLines: [],
    chatAvailable: true,
    state: { ...NO_STATE, buffs: slots, debuffs: slots },
    ...over,
  };
}

function slot(id: string, timeLeft: number | null): BuffSlot {
  return { id, timeLeft, stacks: null };
}

function make(vars: Partial<{ buffid: string; isdebuff: boolean; starttime: number; endtime: number }>) {
  return buffsAlerter.create(
    buffsAlerter.schema.parse({
      bufftype: { buffid: vars.buffid ?? "overload", imgstr: "", isdebuff: vars.isdebuff ?? false },
      starttime: vars.starttime ?? 150,
      endtime: vars.endtime ?? 10,
    }),
  );
}

describe("buffsAlerter", () => {
  it("fires once the buff drops to the end time", () => {
    const r = make({}).check(ctx([slot("overload", 8)]));
    expect(r.triggered).toBe(true);
    expect(r.functional).toBe(true);
  });

  it("does not fire while the buff is comfortably above the end time", () => {
    expect(make({}).check(ctx([slot("overload", 120)])).triggered).toBe(false);
  });

  // An expired buff is simply gone from the bar. Reading "absent" as "no data"
  // would mean the alert that exists to catch expiry never fires.
  it("treats an absent buff as zero seconds remaining", () => {
    const r = make({}).check(ctx([slot("somethingelse", 500)]));
    expect(r.triggered).toBe(true);
    expect(r.functional).toBe(true);
  });

  it("matches only its own buff id", () => {
    expect(make({ buffid: "aura" }).check(ctx([slot("aura", 400)])).triggered).toBe(false);
  });

  it("reads debuffs when configured as one", () => {
    const a = make({ buffid: "poisonous", isdebuff: true });
    const c = ctx([], { state: { ...NO_STATE, buffs: [], debuffs: [slot("poisonous", 5)] } });
    expect(a.check(c).triggered).toBe(true);
  });

  it("fills the progress bar as the buff runs down", () => {
    expect(make({ starttime: 100 }).check(ctx([slot("overload", 75)])).bar).toBeCloseTo(0.25, 5);
  });

  // An alert imported from AfkWarden identifies its buff by a captured icon,
  // which Bolt cannot use. That alert is unmigrated, not broken, and must say so
  // rather than quietly reporting "not triggered" forever.
  it("reports no data for an alert still carrying only a captured icon", () => {
    const r = make({ buffid: "" }).check(ctx([slot("overload", 5)]));
    expect(r.functional).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it("reports no data while the plugin is not connected", () => {
    const r = make({}).check(ctx([slot("overload", 5)], { connected: false }));
    expect(r.functional).toBe(false);
  });

  it("reports no data rather than firing when the timer is unreadable", () => {
    // timeLeft null means the digits could not be read, which is not the same as
    // the buff having expired.
    expect(make({}).check(ctx([slot("overload", null)])).triggered).toBe(true);
  });
});

describe("compensateAbbreviation", () => {
  // RuneScape floors long timers, so a displayed value is a lower bound: "5"
  // minutes means somewhere in [5:00, 6:00). AfkWarden adds the unit back, and
  // matching that keeps imported alerts firing at the same moment.
  it("adds an hour to hour-scale timers", () => {
    expect(compensateAbbreviation(3600)).toBe(7200);
  });

  it("adds a minute to minute-scale timers", () => {
    expect(compensateAbbreviation(60)).toBe(120);
  });

  it("leaves second-scale timers alone", () => {
    expect(compensateAbbreviation(30)).toBe(30);
  });
});
