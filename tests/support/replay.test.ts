import { describe, expect, it } from "vitest";
import { replay, type Session } from "./replay";
import { AlerterBaseSchema } from "~/store/schema";
import { TICK_MS } from "~/engine/loop";

function alerter(over: Record<string, unknown> & { type: string }) {
  return AlerterBaseSchema.parse({ name: "a", ...over });
}

function stateAt(tick: number, over: Record<string, unknown> = {}) {
  return {
    t: "state" as const,
    tick,
    clickIdleMs: 0,
    mouseIdleMs: 0,
    focused: true,
    loggedIn: true,
    characterName: "Sage",
    stats: null,
    buffs: [],
    debuffs: [],
    player: null,
    models: [],
    craftProgress: null,
    dialogOpen: null,
    target: null,
    newDrops: null,
    ...over,
  };
}

/** Six ticks of plugin heartbeat, so the store never goes stale mid-session. */
function heartbeat(ticks: number): Session {
  return {
    messages: Array.from({ length: ticks }, (_, i) => ({
      atMs: i * TICK_MS,
      message: stateAt(i + 1),
    })),
  };
}

describe("replay", () => {
  it("reports no firings for a session where nothing happens", () => {
    const result = replay(heartbeat(5), [
      alerter({ type: "chat", vars: { lines: [{ text: "nope", percent: 100 }], colors: [] } }),
    ]);

    expect(result.firings).toEqual([]);
  });

  // The point of the harness: a whole timeline, not a single frame. A chat line
  // delivered partway through must fire on the tick that observes it and not
  // before, which a per-frame fixture cannot express at all.
  it("fires a chat alerter on the tick its line arrives", () => {
    const session: Session = {
      messages: [
        ...heartbeat(5).messages,
        {
          atMs: TICK_MS * 2 + 10,
          message: {
            t: "chat",
            lines: [{ text: "A Seren spirit appears", colors: [[0, 255, 255]], fragments: [] }],
          },
        },
      ],
    };

    const result = replay(session, [
      alerter({
        name: "seren",
        type: "chat",
        vars: { lines: [{ text: "Seren spirit", percent: 100 }], colors: [[0, 255, 255]] },
      }),
    ]);

    expect(result.firings).toHaveLength(1);
    expect(result.firings[0]?.name).toBe("seren");
    expect(result.firings[0]?.tick).toBe(3);
  });

  // A recorded session that simply stops is how a crashed plugin looks. Alerters
  // must go non-functional rather than keep evaluating the last snapshot forever.
  it("goes non-functional once the recording stops feeding it", () => {
    const result = replay(heartbeat(2), [alerter({ type: "inactive", vars: { delay: 1 } })], {
      ticks: 12,
    });

    expect(result.connectedAtEnd).toBe(false);
    expect(result.functionalAtEnd).toBe(false);
  });
});
