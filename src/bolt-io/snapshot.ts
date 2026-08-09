import type { ChatLine, PluginMessage, ProbeMessage, StateMessage, XpMessage } from "~/bolt-io/protocol";

/**
 * How long a snapshot stays trustworthy without a fresh message.
 *
 * Lua pushes state on the 600ms master tick, so five missed ticks means the
 * plugin stopped, the game closed, or Lua errored out. Generous enough to
 * survive a stutter, short enough that alerters stop acting on a dead reading.
 */
export const STALE_AFTER_MS = 3000;

/**
 * How far an activity estimate must move before it is believed to be a new event
 * rather than delivery jitter. See `SnapshotStore.idleMs`.
 */
export const ACTIVITY_JITTER_MS = 150;

/**
 * Holds the most recent game state pushed from Lua.
 *
 * Two kinds of data arrive here and they behave differently. State is a LEVEL --
 * each snapshot replaces the last, and the newest is the truth. Chat lines and
 * XP drops are EVENTS -- they must accumulate until read, because Lua emits them
 * as it sees them and that is faster than the tick that consumes them.
 */
export class SnapshotStore {
  #state: StateMessage | null = null;
  #lastMessageAt: number | null = null;
  #chat: ChatLine[] = [];
  #xp: XpMessage[] = [];
  #characterName: string | null = null;
  #config: string | null = null;
  #apiVersion: readonly [number, number] | null = null;
  #probe: ProbeMessage | null = null;
  /** When the newest STATE arrived, as distinct from the newest message. */
  #stateAt: number | null = null;
  /** Estimated instant of the last click and the last mouse move, in browser time. */
  #clickAt: number | null = null;
  #moveAt: number | null = null;

  constructor(
    private readonly now: () => number,
    private readonly staleAfterMs: number = STALE_AFTER_MS,
  ) {}

  accept(msg: PluginMessage): void {
    this.#lastMessageAt = this.now();

    switch (msg.t) {
      case "state":
        this.#state = msg;
        this.#characterName = msg.characterName;
        this.#stateAt = this.now();
        this.#clickAt = this.#anchor(this.#clickAt, msg.clickIdleMs);
        this.#moveAt = this.#anchor(this.#moveAt, msg.mouseIdleMs);
        break;
      case "chat":
        this.#chat.push(...msg.lines);
        break;
      case "xp":
        this.#xp.push(msg);
        break;
      case "hello":
        this.#apiVersion = msg.apiVersion;
        break;
      case "config":
        this.#config = msg.data;
        break;
      case "probe":
        this.#probe = msg;
        break;
    }
  }

  /**
   * Whether the plugin is still talking to us.
   *
   * False both before the first message and after the stream dries up. A frozen
   * snapshot is worse than none: without this, every alerter would keep
   * evaluating a reading that stopped being true minutes ago.
   */
  get connected(): boolean {
    if (this.#lastMessageAt === null) return false;
    return this.now() - this.#lastMessageAt <= this.staleAfterMs;
  }

  /** The newest snapshot, retained even once stale so the UI can show what it last saw. */
  get state(): StateMessage | null {
    return this.#state;
  }

  /** The logged-in character, or null in the lobby. Tracks the snapshot. */
  get characterName(): string | null {
    return this.#characterName;
  }

  /**
   * Milliseconds since the newest STATE snapshot arrived, or null before the first.
   *
   * Deliberately not the age of the newest message of any kind. `connected` wants
   * any-message recency and this wants state recency, and one field cannot answer
   * both: main.lua sends the probe report AFTER the state on the same tick, so a
   * shared stamp would read as zero age for a snapshot that is already 600ms old
   * the moment anyone asks for a probe.
   */
  get ageMs(): number | null {
    if (this.#stateAt === null) return null;
    return Math.max(0, this.now() - this.#stateAt);
  }

  /**
   * Milliseconds since the last click, brought up to date and monotone.
   *
   * `state.clickIdleMs` is what Lua measured when it BUILT the snapshot, and
   * snapshots arrive on a 600ms tick, so read raw it is stale by up to a full
   * tick — an inactivity alert set to 30 seconds could fire at 30.6.
   *
   * WHY AN ANCHOR RATHER THAN AN ADDITION. Adding the snapshot's age to each
   * reading looks equivalent and is not: the resulting value is
   * `trueIdle - deliveryLatency`, so it STEPS BY THE CHANGE IN LATENCY at every
   * snapshot boundary — backwards whenever latency rises. A duration since an
   * event going backwards is not cosmetic here. `inactive` triggers on the bare
   * comparison `idleMs >= targetMs` with no hysteresis, so a backward step at the
   * crossing un-fires the alert; AlarmScheduler then emits stop, the player
   * restarts the tone from zero, and main.tsx's `spoken` set is cleared so the
   * alert speaks a SECOND time. On the most common alert type in the config.
   *
   * So the click's instant is estimated once and held. A fresh estimate is
   * adopted only when it moves by more than the jitter this is defending against,
   * which a real click always does — a click resets clickIdleMs to about zero, so
   * the estimate jumps by however long you had been idle. Between clicks the
   * estimate is a fixed point and `now - anchor` is monotone by construction.
   */
  get idleMs(): number {
    if (this.#clickAt === null) return 0;
    return Math.max(0, this.now() - this.#clickAt);
  }

  /** Milliseconds since the mouse last moved or scrolled. Anchored as above. */
  get mouseIdleMs(): number {
    if (this.#moveAt === null) return 0;
    return Math.max(0, this.now() - this.#moveAt);
  }

  /**
   * Adopt a new estimate of when an activity event happened, or keep the old one.
   *
   * The threshold is what separates delivery jitter from a real event. Bridge
   * jitter is a few milliseconds; a click that matters is seconds of idle time
   * away from any threshold, because if you are clicking then you are not idle.
   * So the cost of the threshold is bounded at ~150ms of over-reported idleness
   * in the one case it misjudges, and the benefit is that the value never runs
   * backwards.
   */
  #anchor(previous: number | null, idleMs: number): number {
    const estimate = this.now() - idleMs;
    if (previous === null) return estimate;
    if (Math.abs(estimate - previous) > ACTIVITY_JITTER_MS) return estimate;
    return previous;
  }

  /**
   * The most recent draw-stream report, or null if none has been asked for.
   *
   * Retained rather than drained: it is a reading someone requested and is
   * reading, not an event to be consumed once.
   */
  get probe(): ProbeMessage | null {
    return this.#probe;
  }

  /** Bolt's plugin API version, once the handshake has arrived. */
  get apiVersion(): readonly [number, number] | null {
    return this.#apiVersion;
  }

  /**
   * The stored config blob, or null once taken.
   *
   * Once-only for the same reason the UI must not be re-hydrated mid-session:
   * after startup the app owns this state, and re-applying a stale blob would
   * silently discard edits made since.
   */
  takeConfig(): string | null {
    const out = this.#config;
    this.#config = null;
    return out;
  }

  /** Chat lines since the previous call. Draining is what makes them once-only. */
  drainChat(): ChatLine[] {
    const out = this.#chat;
    this.#chat = [];
    return out;
  }

  /** XP drops since the previous call. */
  drainXp(): XpMessage[] {
    const out = this.#xp;
    this.#xp = [];
    return out;
  }
}
