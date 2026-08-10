import { describe, expect, it } from "vitest";
import { GameStateView } from "~/bolt-io/game-state";
import { SnapshotStore, STALE_AFTER_MS } from "~/bolt-io/snapshot";
import { DiagnosticsSchema, type StateMessage } from "~/bolt-io/protocol";

function stateAt(tick: number, over: Partial<StateMessage> = {}): StateMessage {
  return {
    t: "state",
    tick,
    clickIdleMs: 0,
    mouseIdleMs: 0,
    focused: true,
    loggedIn: true,
    characterName: "Sage",
    stats: { hp: 0.25, pray: 1, sum: 1, dren: 0 },
    buffs: [{ id: "2:1344", timeLeft: 30, stacks: null, slot: 1, source: "icon" }],
    debuffs: [],
    player: null,
    models: [],
    craftProgress: null,
    chatAvailable: true,
    chatScrolledUp: false,
    chatBoxes: 1,
    dialogOpen: null,
    target: null,
    newDrops: null,
    xpTotals: { tot: 5_000 },
    diag: DiagnosticsSchema.parse({}),
    ...over,
  };
}

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("GameStateView", () => {
  it("passes a fresh snapshot through", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    const view = new GameStateView(store);
    store.accept(stateAt(1));

    expect(view.state.xp).toEqual({ tot: 5_000 });
    expect(view.state.stats).toEqual({ hp: 0.25, pray: 1, sum: 1, dren: 0 });
    expect(view.state.buffs).toHaveLength(1);
  });

  /**
   * A STALE SNAPSHOT IS NOT A READING.
   *
   * The store retains the last snapshot forever so the UI can show what it last
   * saw, but the login gate fails open when disconnected, so alerters kept
   * evaluating a frozen reading. Two concrete consequences from one root:
   *
   *  - `xpTotals` freezes, so `readXp` returns a number rather than null,
   *    `lastChangeAt` never advances, and `delay` seconds after the plugin dies
   *    EVERY xpcounter alert fires with functional:true. That is exactly the "a
   *    blind reader is indistinguishable from XP stopped" dishonesty that
   *    switching XP to a level was meant to remove.
   *  - `stats` freezes, so an "HP at or below 25%" alert reports a healthy badge
   *    off a minutes-old reading while health drops in game.
   *
   * Gated here rather than in each alerter because they disagreed: buffs and
   * inactive check ctx.connected, actionbar and xpcounter do not.
   */
  it("reports nothing once the snapshot has gone stale", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    const view = new GameStateView(store);
    store.accept(stateAt(1));

    c.advance(STALE_AFTER_MS + 1);

    expect(store.connected).toBe(false);
    // The store still remembers, for the UI's sake.
    expect(store.state?.tick).toBe(1);
    // The alerters are told nothing.
    expect(view.state.xp).toEqual({});
    expect(view.state.stats).toBeNull();
    expect(view.state.buffs).toEqual([]);
  });

  it("resumes once the plugin starts talking again", () => {
    const c = clock();
    const store = new SnapshotStore(c.now);
    const view = new GameStateView(store);
    store.accept(stateAt(1));
    c.advance(STALE_AFTER_MS + 1);
    expect(view.state.stats).toBeNull();

    store.accept(stateAt(2, { xpTotals: { tot: 6_000 } }));

    expect(view.state.xp).toEqual({ tot: 6_000 });
    expect(view.state.stats).not.toBeNull();
  });

  /**
   * An unreadable counter is a level that is ABSENT, not one that stopped moving.
   * `readXp` turns an empty record into null and the alerter into "no data".
   */
  it("reports no XP when the counter could not be read", () => {
    const store = new SnapshotStore(clock().now);
    const view = new GameStateView(store);
    store.accept(stateAt(1, { xpTotals: null }));

    expect(view.state.xp).toEqual({});
  });
});
