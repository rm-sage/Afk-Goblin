import type { GameState } from "~/engine/types";
import { NO_STATE } from "~/engine/types";
import type { SnapshotStore } from "~/bolt-io/snapshot";

/**
 * Turns the pushed snapshot into the plain-data view alerters consume.
 *
 * XP USED TO BE ACCUMULATED HERE AND IS NOT ANY MORE. Bolt has no XP API, so the
 * first implementation read the floating "+N" drops and folded them into a
 * running total. Two problems, both fatal in practice:
 *
 *  - A drop lingers on screen for about five seconds while it fades, so the total
 *    kept climbing after XP had really stopped and an inactivity alert fired five
 *    seconds late. Reported in game as killing the feature.
 *  - The tally only ever GREW, so once one drop had been seen `readXp` could never
 *    return null again. A reader that had gone blind was indistinguishable from
 *    "XP stopped" — so a detection failure made the alert FIRE rather than report
 *    no data, which is the exact dishonesty this codebase is built to remove.
 *
 * `lua/detect/xp.lua` now reads the XP counter's cumulative totals instead. Those
 * are a LEVEL: they change the instant XP is gained, hold still afterwards, and
 * are absent when the counter cannot be read. Nothing needs accumulating, and
 * `drainInto` exists only so callers keep a stable shape.
 */
export class GameStateView {
  constructor(private readonly snapshot: SnapshotStore) {}

  /**
   * Kept as a no-op so the per-tick call site does not have to know that XP
   * stopped being an event. Removing it would be a churn of every caller and
   * every replay harness for no behavioural gain.
   */
  drainInto(): void {}

  get state(): GameState {
    const s = this.snapshot.state;
    if (s === null) return NO_STATE;

    // A STALE SNAPSHOT IS NOT A READING, and this is the one place that can say
    // so for every alerter at once.
    //
    // The store retains the last snapshot forever on purpose, so the UI can show
    // what it last saw. Handing that to alerters is a different matter: the login
    // gate fails open when disconnected, so they keep evaluating a frozen reading.
    // `xpTotals` freezes, `readXp` returns a number rather than null, and five
    // seconds later every xpcounter alert fires with functional:true — which is
    // exactly the "a blind reader is indistinguishable from XP stopped"
    // dishonesty that switching XP to a level was supposed to remove. The same
    // freeze leaves an action-bar alert reporting a healthy badge off a
    // minutes-old reading while health drops in game.
    //
    // Some alerters check ctx.connected themselves (buffs, inactive) and some do
    // not (actionbar, xpcounter, misc). Gating here rather than there is what
    // makes it uniform, and it gives `ageMs` the production consumer it was
    // written for.
    if (!this.snapshot.connected) return NO_STATE;

    return {
      stats: s.stats,
      buffs: s.buffs,
      debuffs: s.debuffs,
      player: s.player,
      models: s.models,
      craftProgress: s.craftProgress,
      // An empty record when the counter was unreadable, which `readXp` turns
      // into null and the alerter into "no data".
      xp: s.xpTotals ?? {},
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
