import type { ChatLine, PluginMessage, StateMessage, XpMessage } from "~/bolt-io/protocol";

/**
 * How long a snapshot stays trustworthy without a fresh message.
 *
 * Lua pushes state on the 600ms master tick, so five missed ticks means the
 * plugin stopped, the game closed, or Lua errored out. Generous enough to
 * survive a stutter, short enough that alerters stop acting on a dead reading.
 */
export const STALE_AFTER_MS = 3000;

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
  #character: string | null = null;
  #config: string | null = null;

  constructor(
    private readonly now: () => number,
    private readonly staleAfterMs: number = STALE_AFTER_MS,
  ) {}

  accept(msg: PluginMessage): void {
    this.#lastMessageAt = this.now();

    switch (msg.t) {
      case "state":
        this.#state = msg;
        break;
      case "chat":
        this.#chat.push(...msg.lines);
        break;
      case "xp":
        this.#xp.push(msg);
        break;
      case "hello":
        this.#character = msg.character;
        break;
      case "config":
        this.#config = msg.data;
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

  get character(): string | null {
    return this.#character;
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
