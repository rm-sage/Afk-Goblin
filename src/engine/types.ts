import type { ZodType } from "zod";
import type { BuffSlot, ChatLine, DropEvent, Player, Stats, Target } from "~/bolt-io/protocol";
import type { FieldSpec } from "~/engine/fields";

export type RGB = [number, number, number];

export type { BuffSlot, ChatLine, DropEvent, Stats, Target };

/**
 * Everything the plugin can currently see, as plain data.
 *
 * This replaces the old pull-based `ReaderAccess`. Under Alt1 each accessor
 * triggered OCR against a screenshot, so reads were lazy and memoized per tick;
 * Bolt pushes a full snapshot instead, so there is nothing to defer and nothing
 * to memoize. Fields, not methods.
 *
 * `null` consistently means "could not be read", which is distinct from a zero
 * or an empty list, and is what lets `TriggerState.functional` stay honest.
 */
export interface GameState {
  /** Action bar resource levels, each 0..1, or null when unreadable. */
  stats: Stats | null;
  buffs: readonly BuffSlot[];
  debuffs: readonly BuffSlot[];
  /** Player position in world coordinates, or null when not in-game. */
  player: { x: number; y: number; z: number } | null;
  /** Ids of tracked 3D models identified on screen this tick. */
  models: readonly string[];
  craftProgress: number | null;
  /**
   * Cumulative XP per skill code, accumulated from XP drops since the session
   * began. Absolute values are meaningless; alerters diff successive readings,
   * which is exactly what the Alt1 reader supported and why this shape is kept.
   */
  xp: Readonly<Record<string, number>>;
  /** True when a dialog with a continue button is on screen; null if unreadable. */
  dialogOpen: boolean | null;
  /** The currently targeted mob, or null when there is none or it cannot be read. */
  target: Target | null;
  /** Drops seen since the previous tick, or null when unreadable. */
  newDrops: readonly DropEvent[] | null;
}

/** A state that reports nothing readable. Used before the plugin connects, and in tests. */
export const NO_STATE: GameState = {
  stats: null,
  buffs: [],
  debuffs: [],
  player: null,
  models: [],
  craftProgress: null,
  xp: {},
  dialogOpen: null,
  target: null,
  newDrops: null,
};

export type { Player };

/**
 * Everything an alerter is allowed to see on a tick.
 *
 * Alerters receive data, never readers. That is what keeps all 16 of them testable
 * as pure functions without Alt1, a game client, or a screen.
 */
export interface AlerterContext {
  tick: number;
  /** Wall-clock ms, injected rather than read from Date.now() so tests control time. */
  now: number;
  /**
   * Milliseconds SINCE the last click on the game window -- a DURATION, not a
   * timestamp. Alt1's `rsLastActive` had the same meaning under a name that reads
   * like a timestamp; treating it as an epoch value makes every inactivity alert
   * fire permanently. The name here says what the number actually is.
   *
   * Now derived from Bolt's `onmousebutton`, so it is event-driven and exact.
   */
  idleMs: number;
  /**
   * Milliseconds since the mouse last moved or scrolled over the game window.
   *
   * RuneScape counts movement over the client as activity, not just clicks.
   * Under Alt1 this had to be recovered by polling `alt1.mousePosition`, which
   * reported hovers for the client RECTANGLE regardless of what was covering it.
   * Bolt hooks the game's real event stream, so if the event arrived the game
   * received it, and the occlusion problem does not exist.
   */
  mouseIdleMs: number;
  /**
   * Whether the plugin is currently talking to us.
   *
   * False before the first snapshot and after the stream goes stale, which makes
   * every reading meaningless. Replaces Alt1's `hasGameState` permission check.
   */
  connected: boolean;
  /** Deduped union of new lines across every monitored chatbox this tick. */
  chatLines: readonly ChatLine[];
  /**
   * Whether chat is currently readable.
   *
   * Without this a chat alert cannot tell "no matching message" from "I cannot
   * see the chatbox at all", and would report itself healthy while blind.
   */
  chatAvailable: boolean;
  /** Everything else the plugin can see this tick, as plain data. */
  state: GameState;
}

export type TriggerState = {
  triggered: boolean;
  /** Progress toward triggering, 0..1. Drives the progress bar. */
  bar: number;
  /** False when the underlying reader cannot see what it needs. */
  functional: boolean;
};

export const IDLE: TriggerState = { triggered: false, bar: 0, functional: true };

export interface AlerterRuntime {
  check(ctx: AlerterContext): TriggerState;
  /** Called when the user acknowledges or the alerter resets. */
  reset?(): void;
}

export interface AlerterModule<TVars> {
  type: string;
  typename: string;
  descr: string;
  schema: ZodType<TVars>;
  /** Editable settings, in the order they should appear in the editor. */
  fields: FieldSpec[];
  /**
   * How many EVALUATION steps between checks. 1 = every `EVAL_MS`.
   *
   * Counted in evaluation steps, not detection ticks — those are separate
   * cadences now, and this used to say "master ticks... 1 = every 600ms", which
   * became false by a factor of three when the browser stopped evaluating on the
   * push interval. Write `ticks: 3` to mean 600ms, not `ticks: 1`.
   */
  ticks?: number;
  create(vars: TVars): AlerterRuntime;
}

export function defineAlerter<TVars>(m: AlerterModule<TVars>): AlerterModule<TVars> {
  return m;
}

/** Clamp a raw ratio into the 0..1 range the progress bar expects. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
