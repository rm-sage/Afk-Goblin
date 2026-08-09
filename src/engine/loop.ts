import { getAlerterModule } from "~/engine/registry";
import { loginGate } from "~/engine/login-gate";
import type { AlerterBase } from "~/store/schema";
import {
  IDLE,
  NO_STATE,
  type AlerterContext,
  type AlerterRuntime,
  type ChatLine,
  type GameState,
  type TriggerState,
} from "~/engine/types";

/**
 * The DETECTION cadence: how often Lua pushes a snapshot.
 *
 * Matches TICK_US in main.lua. Nothing on this side should assume it is also the
 * rate at which rules are evaluated — see `EVAL_MS`.
 */
export const TICK_MS = 600;

/**
 * The EVALUATION cadence: how often the browser re-runs every alerter.
 *
 * Deliberately faster than TICK_MS, and decoupled from it. A progress bar is
 * computed inside check(), so it only moves when step() runs — at 600ms the bars
 * advanced in visible jumps even though the UI was already painting at 5fps.
 *
 * Evaluating between snapshots is sound because nothing here consumes a snapshot
 * once-only. State is a LEVEL and re-reading it is free; chat lines and XP drops
 * are events that drain, and a step that finds none leaves every alerter's
 * triggered state untouched. The two things that could have misbehaved do not:
 * AlarmScheduler is edge-triggered, so a repeat step emits no command at all, and
 * speech is guarded by a per-alert "already spoken" set. No alerter module sets
 * `ticks`, so the per-alerter cadence divisor is 1 everywhere and running the
 * counter faster cannot skip a check.
 */
export const EVAL_MS = 100;

export type ActiveAlerter = {
  config: AlerterBase;
  runtime: AlerterRuntime | null;
  state: TriggerState;
  /** Master ticks between checks. */
  ticks: number;
  /** Set when the alerter's own check() threw, so one bad type cannot kill the loop. */
  error: string | null;
};

export type LoopDeps = {
  now: () => number;
  /** Milliseconds since the last click on the game window. A duration, not a timestamp. */
  idleMs: () => number;
  /** Milliseconds since the mouse last moved or scrolled over the game window. */
  mouseIdleMs: () => number;
  /** Whether the plugin is currently pushing state. */
  connected: () => boolean;
  /** Whether a character is logged in; false in the lobby. */
  loggedIn: () => boolean;
  /** Whether the logged-out gate is enabled. */
  suppressWhenLoggedOut?: () => boolean;
  /** The latest pushed snapshot. Defaults to reporting nothing. */
  state?: () => GameState;
  /** New chat lines since the previous tick. Draining is the caller's job. */
  chatLines?: () => readonly ChatLine[];
  /** Whether chat is currently readable. Defaults to trusting the connection. */
  chatAvailable?: () => boolean;
};

/** Build a runtime for a stored alerter, or null when its type is unimplemented/invalid. */
export function instantiate(config: AlerterBase): ActiveAlerter {
  const module = getAlerterModule(config.type);
  if (module === undefined) {
    return {
      config,
      runtime: null,
      state: { triggered: false, bar: 0, functional: false },
      ticks: 1,
      error: `Alerter type "${config.type}" is not implemented yet.`,
    };
  }

  const parsed = module.schema.safeParse(config.vars);
  if (!parsed.success) {
    return {
      config,
      runtime: null,
      state: { triggered: false, bar: 0, functional: false },
      ticks: module.ticks ?? 1,
      error: `Invalid settings: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  return {
    config,
    runtime: module.create(parsed.data),
    state: { ...IDLE },
    ticks: module.ticks ?? 1,
    error: null,
  };
}

/**
 * The master tick.
 *
 * Reads the latest snapshot pushed from the plugin and hands it to every
 * alerter as plain data. There is no capture, no reader positions and no
 * geometry to invalidate: the whole self-healing-anchor apparatus that existed
 * to survive a window resize is gone, because nothing is located by searching a
 * screenshot any more.
 */
export class TickLoop {
  tick = 0;
  alerters: ActiveAlerter[] = [];

  constructor(private readonly deps: LoopDeps) {}

  setAlerters(configs: readonly AlerterBase[]): void {
    this.alerters = configs.map(instantiate);
  }

  /** Set when every alert is being held, e.g. because the player is logged out. */
  heldReason: string | null = null;

  step(): void {
    this.tick++;

    const connected = this.deps.connected();

    const gate = loginGate(
      { loggedIn: this.deps.loggedIn(), connected },
      this.deps.suppressWhenLoggedOut?.() ?? false,
    );

    if (gate.held) {
      this.heldReason = gate.reason;
      // Clear rather than freeze: an alert that fired just before you logged out
      // should not still be screaming when you get back to the login screen.
      for (const a of this.alerters) {
        a.runtime?.reset?.();
        a.state = { triggered: false, bar: 0, functional: false };
      }
      return;
    }
    this.heldReason = null;

    const ctx: AlerterContext = {
      tick: this.tick,
      now: this.deps.now(),
      idleMs: this.deps.idleMs(),
      mouseIdleMs: this.deps.mouseIdleMs(),
      connected,
      chatLines: this.deps.chatLines?.() ?? [],
      // Not simply `connected`: chat needs message timestamps enabled in game,
      // and goes unreadable when the box is scrolled up. Both are states the
      // user can fix, and a chat alert must report itself blind rather than
      // healthy-and-silent while either holds.
      chatAvailable: connected && (this.deps.chatAvailable?.() ?? true),
      state: this.deps.state?.() ?? NO_STATE,
    };

    for (const a of this.alerters) {
      if (a.runtime === null) continue;
      if (a.config.paused) {
        a.state = { triggered: false, bar: 0, functional: a.state.functional };
        continue;
      }
      if (this.tick % a.ticks !== 0) continue;

      try {
        a.state = a.runtime.check(ctx);
        a.error = null;
      } catch (e) {
        // One misbehaving alerter must not stop the other 107.
        a.error = (e as Error).message;
        a.state = { triggered: false, bar: 0, functional: false };
      }
    }
  }

  /** Alerters currently firing, in configured order. */
  triggered(): ActiveAlerter[] {
    return this.alerters.filter((a) => a.state.triggered);
  }
}
