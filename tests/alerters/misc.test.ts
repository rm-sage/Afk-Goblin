import { describe, expect, it } from "vitest";
import { dialogAlerter, dropsAlerter, targetDeathAlerter } from "~/alerters/misc";
import type { AlerterContext } from "~/engine/types";
import { NO_STATE, type DropEvent, type Target as TargetState } from "~/engine/types";

function ctx(
  state: Partial<typeof NO_STATE>,
  over: Partial<AlerterContext> = {},
): AlerterContext {
  return {
    tick: 1,
    now: 1_000_000,
    idleMs: 999_999,
    mouseIdleMs: 999_999,
    connected: true,
    chatLines: [],
    chatAvailable: true,
    state: { ...NO_STATE, ...state },
    ...over,
  };
}

describe("dialogAlerter", () => {
  it("is non-functional when the dialog reader sees nothing readable", () => {
    const r = dialogAlerter.create({}).check(ctx({ dialogOpen: null }));
    expect(r.functional).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it("triggers while a dialog is open", () => {
    const r = dialogAlerter.create({}).check(ctx({ dialogOpen: true }));
    expect(r.triggered).toBe(true);
    expect(r.bar).toBe(1);
  });

  it("clears once the dialog is dismissed", () => {
    const a = dialogAlerter.create({});
    a.check(ctx({ dialogOpen: true }));
    expect(a.check(ctx({ dialogOpen: false })).triggered).toBe(false);
  });
});

describe("targetDeathAlerter", () => {
  const live: TargetState = { hp: 0.8, name: "Rune dragon" };

  // AfkWarden treats "no target" as death unconditionally, so its alert sits
  // triggered before you have engaged anything.
  it("does not fire before a target has ever been seen", () => {
    const r = targetDeathAlerter.create({}).check(ctx({ target: null }));
    expect(r.triggered).toBe(false);
    expect(r.functional).toBe(true);
  });

  it("stays quiet while the target is alive", () => {
    const a = targetDeathAlerter.create({});
    expect(a.check(ctx({ target: live })).triggered).toBe(false);
  });

  it("fires when the target reaches zero health", () => {
    const a = targetDeathAlerter.create({});
    a.check(ctx({ target: live }));
    expect(a.check(ctx({ target: ({ hp: 0, name: "Rune dragon" }) })).triggered).toBe(true);
  });

  it("fires when the target disappears entirely", () => {
    const a = targetDeathAlerter.create({});
    a.check(ctx({ target: live }));
    expect(a.check(ctx({ target: null })).triggered).toBe(true);
  });

  it("re-arms on a new target", () => {
    const a = targetDeathAlerter.create({});
    a.check(ctx({ target: live }));
    a.check(ctx({ target: null }));
    expect(a.check(ctx({ target: live })).triggered).toBe(false);
  });
});

describe("dropsAlerter", () => {
  const drop = (name: string): DropEvent => ({ name, amount: 1 });

  it("is non-functional with no drops configured", () => {
    const a = dropsAlerter.create({ triggerdrops: [] });
    expect(a.check(ctx({ newDrops: [] })).functional).toBe(false);
  });

  it("is non-functional when the drop log cannot be read", () => {
    const a = dropsAlerter.create({ triggerdrops: [{ text: "Draconic visage" }] });
    expect(a.check(ctx({ newDrops: null })).functional).toBe(false);
  });

  it("triggers on a matching drop", () => {
    const a = dropsAlerter.create({ triggerdrops: [{ text: "Draconic visage" }] });
    expect(a.check(ctx({ newDrops: [drop("Draconic visage")] })).triggered).toBe(true);
  });

  it("matches case-insensitively and as a substring", () => {
    const a = dropsAlerter.create({ triggerdrops: [{ text: "visage" }] });
    expect(a.check(ctx({ newDrops: [drop("Draconic Visage")] })).triggered).toBe(true);
  });

  it("ignores drops that do not match", () => {
    const a = dropsAlerter.create({ triggerdrops: [{ text: "visage" }] });
    expect(a.check(ctx({ newDrops: [drop("Adamant bar")] })).triggered).toBe(false);
  });

  it("stays triggered across ticks until acknowledged", () => {
    const a = dropsAlerter.create({ triggerdrops: [{ text: "visage" }] });
    a.check(ctx({ newDrops: [drop("Draconic visage")] }));
    expect(a.check(ctx({ newDrops: [] })).triggered).toBe(true);
  });

  // Acting on the alert is the acknowledgement.
  it("clears once the player clicks after the drop", () => {
    const a = dropsAlerter.create({ triggerdrops: [{ text: "visage" }] });
    a.check(ctx({ newDrops: [drop("Draconic visage")] }, { now: 1_000_000, idleMs: 900_000 }));
    const r = a.check(ctx({ newDrops: [] }, { now: 1_005_000, idleMs: 1_000 }));
    expect(r.triggered).toBe(false);
  });
});
