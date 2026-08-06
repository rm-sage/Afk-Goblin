import { describe, expect, it, vi } from "vitest";
import { TickLoop, instantiate, type LoopDeps } from "~/engine/loop";
import { AlerterBaseSchema, type AlerterBase } from "~/store/schema";
import { NO_STATE, type ChatLine } from "~/engine/types";

function alerter(over: Partial<AlerterBase> & { type: string }): AlerterBase {
  return AlerterBaseSchema.parse({ name: "a", ...over });
}

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    now: () => 0,
    idleMs: () => 0,
    mouseIdleMs: () => 0,
    connected: () => true,
    loggedIn: () => true,
    state: () => NO_STATE,
    chatLines: () => [],
    ...over,
  };
}

function line(text: string, colors: [number, number, number][] = []): ChatLine {
  return { text, colors, fragments: [] };
}

describe("instantiate", () => {
  it("builds a runtime for an implemented type", () => {
    const a = instantiate(alerter({ type: "inactive", vars: { delay: 10 } }));
    expect(a.runtime).not.toBeNull();
    expect(a.error).toBeNull();
  });

  // Losing an alert silently is the exact failure mode this project exists to remove.
  it("flags an unimplemented type instead of dropping it", () => {
    const a = instantiate(alerter({ type: "fightkiln" }));
    expect(a.runtime).toBeNull();
    expect(a.error).toMatch(/not implemented/i);
    expect(a.state.functional).toBe(false);
  });

  it("flags invalid settings visibly", () => {
    const a = instantiate(alerter({ type: "inactive", vars: { delay: -1 } }));
    expect(a.runtime).toBeNull();
    expect(a.error).toMatch(/invalid settings/i);
  });
});

describe("TickLoop", () => {
  it("fires a chat alerter from pushed lines", () => {
    const loop = new TickLoop(
      deps({ chatLines: () => [line("A Seren spirit appears", [[0, 255, 255]])] }),
    );
    loop.setAlerters([
      alerter({
        type: "chat",
        vars: { lines: [{ text: "Seren spirit", percent: 100 }], colors: [[0, 255, 255]] },
      }),
    ]);
    loop.step();
    expect(loop.triggered()).toHaveLength(1);
  });

  it("skips paused alerters", () => {
    const loop = new TickLoop(
      deps({ chatLines: () => [line("A Seren spirit appears", [[0, 255, 255]])] }),
    );
    loop.setAlerters([
      alerter({
        type: "chat",
        paused: true,
        vars: { lines: [{ text: "Seren spirit", percent: 100 }], colors: [] },
      }),
    ]);
    loop.step();
    expect(loop.triggered()).toHaveLength(0);
  });

  it("isolates a throwing alerter instead of killing the loop", () => {
    const loop = new TickLoop(deps());
    loop.setAlerters([
      alerter({ type: "inactive", name: "bad", vars: { delay: 1 } }),
      alerter({ type: "inactive", name: "good", vars: { delay: 1 } }),
    ]);
    loop.alerters[0]!.runtime = {
      check() {
        throw new Error("boom");
      },
    };

    expect(() => loop.step()).not.toThrow();
    expect(loop.alerters[0]!.error).toBe("boom");
    expect(loop.alerters[0]!.state.functional).toBe(false);
    expect(loop.alerters[1]!.error).toBeNull();
  });

  it("honours per-alerter tick divisors", () => {
    const loop = new TickLoop(deps());
    loop.setAlerters([alerter({ type: "inactive", vars: { delay: 1 } })]);
    const check = vi.fn(() => ({ triggered: false, bar: 0, functional: true }));
    loop.alerters[0]!.runtime = { check };
    loop.alerters[0]!.ticks = 3;

    loop.step();
    loop.step();
    expect(check).not.toHaveBeenCalled();
    loop.step();
    expect(check).toHaveBeenCalledTimes(1);
  });

  // Chat lines are drained by the caller, so a line pushed on one tick must not
  // be re-evaluated on the next. Draining is what makes an alert fire once.
  it("only sees each chat line on the tick it arrives", () => {
    let pending: ChatLine[] = [line("A Seren spirit appears", [[0, 255, 255]])];
    const loop = new TickLoop(
      deps({
        chatLines: () => {
          const out = pending;
          pending = [];
          return out;
        },
      }),
    );
    loop.setAlerters([
      alerter({
        type: "chat",
        vars: { lines: [{ text: "Seren spirit", percent: 100 }], colors: [[0, 255, 255]] },
      }),
    ]);

    loop.step();
    expect(loop.triggered()).toHaveLength(1);
  });

  it("holds every alert and clears its state while logged out", () => {
    const loop = new TickLoop(
      deps({ loggedIn: () => false, suppressWhenLoggedOut: () => true }),
    );
    loop.setAlerters([alerter({ type: "inactive", vars: { delay: 1 } })]);

    loop.step();

    expect(loop.heldReason).toMatch(/logged out|lobby/i);
    expect(loop.triggered()).toHaveLength(0);
    expect(loop.alerters[0]!.state.functional).toBe(false);
  });

  // Not knowing must never be treated as knowing: with no data from the plugin,
  // holding every alert would silence exactly what the app exists to catch.
  it("does not hold alerts when the plugin is not connected", () => {
    const loop = new TickLoop(
      deps({ connected: () => false, loggedIn: () => false, suppressWhenLoggedOut: () => true }),
    );
    loop.setAlerters([alerter({ type: "inactive", vars: { delay: 1 } })]);

    loop.step();

    expect(loop.heldReason).toBeNull();
  });
});
