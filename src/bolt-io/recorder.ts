import type { PluginMessage } from "~/bolt-io/protocol";

/**
 * Roughly an hour of heartbeat at 600ms, plus room for chat and XP events.
 * Bounded because this lives in a browser inside the game process, which is the
 * last place that should leak memory over an AFK session.
 */
export const DEFAULT_CAPACITY = 5000;

type Entry = { at: number; message: PluginMessage };

/**
 * Captures the bridge stream so a real session can be replayed in tests.
 *
 * Recording happens here rather than in Lua deliberately: this side receives
 * exactly the same bytes, and it has somewhere to put them. Lua's only write
 * path is `bolt.saveconfig`, which is the wrong tool for an append-only log.
 *
 * Timestamps are stored absolutely and rebased on export, so trimming old
 * entries cannot leave a session that starts at an arbitrary offset.
 */
export class SessionRecorder {
  #entries: Entry[] = [];

  constructor(
    private readonly now: () => number,
    private readonly capacity: number = DEFAULT_CAPACITY,
  ) {}

  record(message: PluginMessage): void {
    this.#entries.push({ at: this.now(), message });
    if (this.#entries.length > this.capacity) {
      this.#entries.splice(0, this.#entries.length - this.capacity);
    }
  }

  clear(): void {
    this.#entries = [];
  }

  /** A session whose first message sits at zero, ready to hand to the replay driver. */
  toSession(): { messages: { atMs: number; message: PluginMessage }[] } {
    const origin = this.#entries[0]?.at ?? 0;
    return {
      messages: this.#entries.map((e) => ({ atMs: e.at - origin, message: e.message })),
    };
  }

  get length(): number {
    return this.#entries.length;
  }
}
