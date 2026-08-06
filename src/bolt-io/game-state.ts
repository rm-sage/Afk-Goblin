import type { GameState } from "~/engine/types";
import { NO_STATE } from "~/engine/types";
import type { SnapshotStore } from "~/bolt-io/snapshot";

/**
 * Turns the pushed snapshot into the plain-data view alerters consume.
 *
 * The only real work here is XP. Alt1 could read a skill's CURRENT total off
 * the XP counter, and `xpcounter` alerts are written to diff successive
 * readings. Bolt reports XP DROPS instead — events, not a level — so drops are
 * accumulated into a running per-skill total. The absolute value is meaningless
 * (it starts at zero each session), but the differences are exactly right,
 * which is all the alerters ever used.
 */
export class GameStateView {
  #xp: Record<string, number> = {};

  constructor(private readonly snapshot: SnapshotStore) {}

  /**
   * Fold any XP drops seen since the last call into the running totals.
   * Call once per tick, before reading `state`.
   */
  drainInto(): void {
    for (const drop of this.snapshot.drainXp()) {
      this.#xp[drop.skill] = (this.#xp[drop.skill] ?? 0) + drop.amount;
    }
  }

  get state(): GameState {
    const s = this.snapshot.state;
    if (s === null) return { ...NO_STATE, xp: this.#xp };

    return {
      stats: s.stats,
      buffs: s.buffs,
      debuffs: s.debuffs,
      player: s.player,
      models: s.models,
      craftProgress: s.craftProgress,
      xp: this.#xp,
      dialogOpen: s.dialogOpen,
      target: s.target,
      newDrops: s.newDrops,
    };
  }
}

/** Convenience for tests and one-shot reads. */
export function toGameState(snapshot: SnapshotStore): GameState {
  const view = new GameStateView(snapshot);
  view.drainInto();
  return view.state;
}
