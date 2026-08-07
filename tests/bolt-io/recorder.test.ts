import { describe, expect, it } from "vitest";
import { SessionRecorder } from "~/bolt-io/recorder";
import type { PluginMessage } from "~/bolt-io/protocol";

const HELLO: PluginMessage = { t: "hello", apiVersion: [1, 0] };
const XP: PluginMessage = { t: "xp", skill: "div", amount: 100 };

function clock(start = 5_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("SessionRecorder", () => {
  it("starts empty", () => {
    expect(new SessionRecorder(clock().now).toSession().messages).toEqual([]);
  });

  // Timestamps are relative to the first message, not to the epoch, so a
  // recording replays identically whenever it was captured.
  it("timestamps messages from the first one, not from the clock's origin", () => {
    const c = clock();
    const rec = new SessionRecorder(c.now);

    rec.record(HELLO);
    c.advance(600);
    rec.record(XP);

    const { messages } = rec.toSession();
    expect(messages[0]?.atMs).toBe(0);
    expect(messages[1]?.atMs).toBe(600);
  });

  it("keeps the messages themselves untouched", () => {
    const rec = new SessionRecorder(clock().now);
    rec.record(XP);
    expect(rec.toSession().messages[0]?.message).toEqual(XP);
  });

  // A session runs for hours at ~100 messages a minute. Without a cap this grows
  // without bound inside the game process's browser, which is the last place
  // that should leak memory.
  it("keeps only the most recent messages once full", () => {
    const rec = new SessionRecorder(clock().now, 3);
    for (let i = 0; i < 5; i++) rec.record({ t: "xp", skill: `s${i}`, amount: i });

    const { messages } = rec.toSession();
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => (m.message as { skill: string }).skill)).toEqual(["s2", "s3", "s4"]);
  });

  it("rebases timestamps onto the oldest surviving message after trimming", () => {
    const c = clock();
    const rec = new SessionRecorder(c.now, 2);

    rec.record(HELLO);
    c.advance(1000);
    rec.record(XP);
    c.advance(500);
    rec.record(XP);

    const { messages } = rec.toSession();
    expect(messages[0]?.atMs).toBe(0);
    expect(messages[1]?.atMs).toBe(500);
  });

  it("clears back to empty", () => {
    const rec = new SessionRecorder(clock().now);
    rec.record(HELLO);
    rec.clear();
    expect(rec.toSession().messages).toEqual([]);
  });
});
