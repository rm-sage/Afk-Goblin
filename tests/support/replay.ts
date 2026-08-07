import type { PluginMessage } from "~/bolt-io/protocol";
import { SnapshotStore } from "~/bolt-io/snapshot";
import { GameStateView } from "~/bolt-io/game-state";
import { TICK_MS, TickLoop } from "~/engine/loop";
import type { AlerterBase } from "~/store/schema";

/**
 * Replay a recorded bridge session through the real engine.
 *
 * This is what replaces Alt1's `PasteInput` workflow. That let a screenshot be
 * pasted into an ordinary browser and run through a reader, which was useful but
 * fundamentally a SINGLE FRAME. Everything crossing this bridge is JSON, so a
 * whole session can be recorded and replayed instead — and most alerting bugs
 * are about timing, ordering and staleness, none of which a single frame can
 * express.
 *
 * Time is virtual: the clock only moves when this driver moves it, so a
 * ten-minute session replays instantly and deterministically.
 */

export type RecordedMessage = {
  /** Milliseconds since the start of the recording. */
  atMs: number;
  message: PluginMessage;
};

export type Session = { messages: RecordedMessage[] };

export type Firing = { tick: number; name: string };

export type ReplayResult = {
  /** Every transition from not-triggered to triggered, in order. */
  firings: Firing[];
  ticks: number;
  connectedAtEnd: boolean;
  /** Whether every alerter could still see what it needs on the final tick. */
  functionalAtEnd: boolean;
};

export type ReplayOptions = {
  /**
   * How many ticks to run. Defaults to covering the recording exactly.
   *
   * Set it longer than the recording to model a plugin that stopped talking —
   * which is how a crash looks from this side, and the case where a frozen
   * snapshot would otherwise be believed forever.
   */
  ticks?: number;
};

export function replay(
  session: Session,
  alerters: readonly AlerterBase[],
  options: ReplayOptions = {},
): ReplayResult {
  let now = 0;
  const store = new SnapshotStore(() => now);
  const view = new GameStateView(store);

  const loop = new TickLoop({
    now: () => now,
    idleMs: () => store.state?.clickIdleMs ?? 0,
    mouseIdleMs: () => store.state?.mouseIdleMs ?? 0,
    connected: () => store.connected,
    loggedIn: () => store.state?.loggedIn ?? false,
    state: () => view.state,
    chatLines: () => store.drainChat(),
  });
  loop.setAlerters(alerters);

  // Delivered in time order regardless of how the recording was assembled, so a
  // hand-written fixture cannot accidentally depend on array order.
  const pending = [...session.messages].sort((a, b) => a.atMs - b.atMs);
  let next = 0;

  const lastAt = pending[pending.length - 1]?.atMs ?? 0;
  const totalTicks = options.ticks ?? Math.max(1, Math.ceil(lastAt / TICK_MS) + 1);

  const firings: Firing[] = [];
  const wasTriggered = new Set<string>();

  for (let tick = 1; tick <= totalTicks; tick++) {
    now = tick * TICK_MS;

    // Everything recorded at or before this instant has arrived by now.
    while (next < pending.length && pending[next]!.atMs <= now) {
      store.accept(pending[next]!.message);
      next++;
    }

    view.drainInto();
    loop.step();

    for (const a of loop.alerters) {
      const key = a.config.name;
      if (a.state.triggered) {
        if (!wasTriggered.has(key)) {
          wasTriggered.add(key);
          firings.push({ tick, name: key });
        }
      } else {
        wasTriggered.delete(key);
      }
    }
  }

  return {
    firings,
    ticks: totalTicks,
    connectedAtEnd: store.connected,
    functionalAtEnd: loop.alerters.every((a) => a.state.functional),
  };
}
