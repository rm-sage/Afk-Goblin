import { describe, expect, it } from "vitest";
import { SnapshotStore, STALE_AFTER_MS } from "~/bolt-io/snapshot";
import type { ChatMessage, StateMessage, XpMessage } from "~/bolt-io/protocol";

function stateAt(tick: number): StateMessage {
  return {
    t: "state",
    tick,
    clickIdleMs: 0,
    mouseIdleMs: 0,
    focused: true,
    loggedIn: true,
    stats: { hp: 1, pray: 1, sum: 1, dren: 0 },
    buffs: [],
    debuffs: [],
    player: null,
    models: [],
    craftProgress: null,
  };
}

function chat(...texts: string[]): ChatMessage {
  return {
    t: "chat",
    lines: texts.map((text) => ({ text, colors: [], fragments: [text] })),
  };
}

const XP: XpMessage = { t: "xp", skill: "div", amount: 1200 };

/** A clock the test drives by hand, matching the `now: () => number` convention. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("SnapshotStore", () => {
  it("reports disconnected before any message arrives", () => {
    const store = new SnapshotStore(clock().now);

    expect(store.connected).toBe(false);
    expect(store.state).toBeNull();
  });

  it("exposes the latest state once one arrives", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);

    store.accept(stateAt(1));
    store.accept(stateAt(2));

    expect(store.connected).toBe(true);
    expect(store.state?.tick).toBe(2);
  });

  // A frozen snapshot is worse than no snapshot: alerters would act on stale
  // readings forever if the plugin stopped or the game closed. Going stale is
  // what makes `functional: false` reachable.
  it("goes stale when the plugin stops sending", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    store.accept(stateAt(1));

    c.advance(STALE_AFTER_MS + 1);

    expect(store.connected).toBe(false);
    expect(store.state?.tick).toBe(1);
  });

  it("recovers when messages resume after a stall", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    store.accept(stateAt(1));
    c.advance(STALE_AFTER_MS + 1);

    store.accept(stateAt(2));

    expect(store.connected).toBe(true);
  });

  it("drains chat lines exactly once", () => {
    const store = new SnapshotStore(clock().now);
    store.accept(chat("first"));

    expect(store.drainChat().map((l) => l.text)).toEqual(["first"]);
    expect(store.drainChat()).toEqual([]);
  });

  // Lua emits chat as it sees it, which is faster than the 600ms master tick,
  // so more than one message can land between drains and none may be dropped.
  it("accumulates chat lines across messages between drains", () => {
    const store = new SnapshotStore(clock().now);

    store.accept(chat("first", "second"));
    store.accept(chat("third"));

    expect(store.drainChat().map((l) => l.text)).toEqual(["first", "second", "third"]);
  });

  it("drains xp drops exactly once", () => {
    const store = new SnapshotStore(clock().now);
    store.accept(XP);

    expect(store.drainXp()).toEqual([XP]);
    expect(store.drainXp()).toEqual([]);
  });

  // Handed over once at startup, before any state arrives, so the UI can render
  // stored presets while the game is still loading.
  it("holds the stored config blob until it is taken", () => {
    const store = new SnapshotStore(clock().now);
    store.accept({ t: "config", data: '{"presets":[]}' });

    expect(store.takeConfig()).toBe('{"presets":[]}');
    expect(store.takeConfig()).toBeNull();
  });

  it("has no config before one is handed over", () => {
    expect(new SnapshotStore(clock().now).takeConfig()).toBeNull();
  });

  it("records the character from the hello handshake", () => {
    const store = new SnapshotStore(clock().now);

    store.accept({ t: "hello", apiVersion: [1, 0], character: "Sage" });

    expect(store.character).toBe("Sage");
  });
});
