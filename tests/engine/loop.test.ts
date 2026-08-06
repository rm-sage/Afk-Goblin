import { describe, expect, it, vi } from "vitest";
import { GeometryWatch, type Alt1Host } from "~/alt1-io/geometry";
import { ChatboxPool, type ChatPos } from "~/readers/chatbox-pool";
import { TickLoop, instantiate, type LoopDeps } from "~/engine/loop";
import { AlerterBaseSchema, type AlerterBase } from "~/store/schema";
import type { ChatLine, RGB } from "~/engine/types";

function host(over: Partial<Alt1Host> = {}): Alt1Host {
  return { rsX: 0, rsY: 0, rsWidth: 1920, rsHeight: 1080, rsScaling: 1, rsLinked: true, ...over };
}

function pool(lines: ChatLine[] = []): ChatboxPool {
  const rect = { x: 0, y: 0, width: 400, height: 120 };
  const pos: ChatPos = { mainbox: { rect }, boxes: [{ rect }] };
  return new ChatboxPool({
    makeReader: () => ({
      pos: null,
      readargs: { colors: [] },
      find: () => pos,
      read: () => lines,
    }),
  });
}

function alerter(over: Partial<AlerterBase> & { type: string }): AlerterBase {
  return AlerterBaseSchema.parse({ name: "a", ...over });
}

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    now: () => 0,
    idleMs: () => 0,
    mouseIdleMs: () => 0,
    connected: () => true,
    geometry: new GeometryWatch(host()),
    capture: () => ({}),
    chat: pool(),
    ...over,
  };
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
  it("takes exactly one capture per step", () => {
    const capture = vi.fn(() => ({}));
    const loop = new TickLoop(deps({ capture }));
    loop.setAlerters([
      alerter({ type: "inactive", vars: { delay: 1 } }),
      alerter({ type: "chat", vars: { lines: [{ text: "hi", percent: 100 }], colors: [] } }),
    ]);
    loop.step();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("invalidates readers when geometry changes", () => {
    const h = host();
    const chat = pool();
    const spy = vi.spyOn(chat, "invalidate");
    const loop = new TickLoop(deps({ geometry: new GeometryWatch(h), chat }));
    loop.setAlerters([]);

    loop.step(); // first poll always reports change
    spy.mockClear();

    loop.step();
    expect(spy).not.toHaveBeenCalled();

    h.rsWidth = 1280;
    loop.step();
    expect(spy).toHaveBeenCalledWith("geometry-change");
  });

  it("fires a chat alerter from pooled lines", () => {
    const chat = pool([{ text: "A Seren spirit appears", colors: [[0, 255, 255]], fragments: [] }]);
    const loop = new TickLoop(deps({ chat }));
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
    const chat = pool([{ text: "A Seren spirit appears", colors: [[0, 255, 255]], fragments: [] }]);
    const loop = new TickLoop(deps({ chat }));
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

  it("passes the union of chat colours to the pool each tick", () => {
    const chat = pool();
    const spy = vi.spyOn(chat, "update");
    const loop = new TickLoop(deps({ chat }));
    loop.setAlerters([
      alerter({ type: "chat", vars: { lines: [{ text: "a", percent: 100 }], colors: [[1, 2, 3]] } }),
      alerter({
        type: "chat",
        vars: { lines: [{ text: "b", percent: 100 }], colors: [[1, 2, 3], [4, 5, 6]] },
      }),
    ]);
    loop.step();

    expect(spy.mock.calls[0]![2] as RGB[]).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("excludes paused alerters from the colour union", () => {
    const chat = pool();
    const spy = vi.spyOn(chat, "update");
    const loop = new TickLoop(deps({ chat }));
    loop.setAlerters([
      alerter({
        type: "chat",
        paused: true,
        vars: { lines: [{ text: "a", percent: 100 }], colors: [[9, 9, 9]] },
      }),
      alerter({ type: "chat", vars: { lines: [{ text: "b", percent: 100 }], colors: [[1, 2, 3]] } }),
    ]);
    loop.step();

    expect(spy.mock.calls[0]![2]).toEqual([[1, 2, 3]]);
  });

  it("survives a failed capture", () => {
    const loop = new TickLoop(deps({ capture: () => null }));
    loop.setAlerters([alerter({ type: "inactive", vars: { delay: 1 } })]);
    expect(() => loop.step()).not.toThrow();
  });
});
