import { describe, expect, it } from "vitest";
import { SnapshotStore, STALE_AFTER_MS } from "~/bolt-io/snapshot";
import { DiagnosticsSchema } from "~/bolt-io/protocol";
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
    chatAvailable: true,
    chatScrolledUp: false,
    chatBoxes: 1,
    diag: DiagnosticsSchema.parse({}),
    dialogOpen: null,
    target: null,
    newDrops: null,
    xpTotals: null,
    characterName: null,
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

  // Not from the handshake: the plugin starts before login, so the characterName is
  // still empty then. It arrives on the snapshot once there is one.
  it("records the characterName from the state snapshot", () => {
    const store = new SnapshotStore(clock().now);

    store.accept({ ...stateAt(1), characterName: "Sage" });

    expect(store.characterName).toBe("Sage");
  });

  it("clears the characterName on returning to the lobby", () => {
    const store = new SnapshotStore(clock().now);
    store.accept({ ...stateAt(1), characterName: "Sage" });

    store.accept({ ...stateAt(2), characterName: null });

    expect(store.characterName).toBeNull();
  });

  /**
   * `state.clickIdleMs` is what Lua measured when it BUILT the snapshot, and
   * snapshots arrive on a 600ms tick — so read raw it is stale by up to a full
   * tick. Both terms are durations, so adding the snapshot's own age is the
   * correct value rather than a smoothing trick, and it is what lets an
   * inactivity bar advance continuously between pushes.
   */
  it("brings idle timers up to date with the snapshot's age", () => {
    let now = 1_000;
    const store = new SnapshotStore(() => now);

    const state = stateAt(1);
    state.clickIdleMs = 4_000;
    state.mouseIdleMs = 900;
    store.accept(state);

    expect(store.ageMs).toBe(0);
    expect(store.idleMs).toBe(4_000);
    expect(store.mouseIdleMs).toBe(900);

    now += 450;
    expect(store.ageMs).toBe(450);
    expect(store.idleMs).toBe(4_450);
    expect(store.mouseIdleMs).toBe(1_350);

    // A fresh snapshot replaces the reading rather than adding to it.
    const next = stateAt(2);
    next.clickIdleMs = 5_000;
    next.mouseIdleMs = 0;
    store.accept(next);
    expect(store.idleMs).toBe(5_000);
    expect(store.mouseIdleMs).toBe(0);
  });

  it("reports no age and zero idle before the first snapshot", () => {
    const store = new SnapshotStore(() => 5_000);
    expect(store.ageMs).toBeNull();
    expect(store.idleMs).toBe(0);
    expect(store.mouseIdleMs).toBe(0);
  });

  /**
   * `connected` wants any-message recency; the idle extrapolation wants STATE
   * recency. One stamp cannot answer both, and main.lua sends the probe report
   * AFTER the state on the same tick — so a shared stamp would report a snapshot
   * as freshly arrived every time anyone pressed the probe button.
   */
  it("ages from the last state, not the last message of any kind", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    store.accept(stateAt(1));

    c.advance(400);
    expect(store.ageMs).toBe(400);

    // A probe report is a message, but it is not a snapshot.
    store.accept({ t: "probe", shapes: [], icons: [], bars: [], texts: [], truncated: false });

    expect(store.ageMs).toBe(400);
    expect(store.connected).toBe(true);
  });

  /**
   * THE FLAP THIS PREVENTS. Adding a snapshot's age to each reading yields
   * `trueIdle - deliveryLatency`, so the value steps by the CHANGE in latency at
   * every snapshot boundary — backwards whenever latency rises. `inactive`
   * triggers on the bare comparison `idleMs >= targetMs` with no hysteresis, so a
   * backward step at the crossing un-fires the alert: the alarm stops and
   * restarts from zero and the alert speaks a second time.
   *
   * Anchoring the click's instant instead makes the value monotone by
   * construction between real clicks.
   */
  it("never runs an idle timer backwards when delivery latency rises", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);

    store.accept({ ...stateAt(1), clickIdleMs: 5_000 });
    expect(store.idleMs).toBe(5_000);

    // One tick later the true idle time is 5600. A snapshot that took 20ms longer
    // to arrive reports slightly less than that.
    c.advance(600);
    const before = store.idleMs;
    store.accept({ ...stateAt(2), clickIdleMs: 5_580 });

    expect(store.idleMs).toBeGreaterThanOrEqual(before);
    expect(store.idleMs).toBe(5_600);
  });

  /** A real click moves the anchor immediately — it is nothing like jitter. */
  it("resets an idle timer as soon as a click is reported", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    store.accept({ ...stateAt(1), clickIdleMs: 5_000, mouseIdleMs: 5_000 });

    c.advance(600);
    store.accept({ ...stateAt(2), clickIdleMs: 10, mouseIdleMs: 10 });

    expect(store.idleMs).toBe(10);
    expect(store.mouseIdleMs).toBe(10);
  });
});