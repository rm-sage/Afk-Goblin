import { describe, expect, it } from "vitest";
import { chatBox, loadPlugin, TICK_US, type LuaPlugin, type SentMessage } from "./harness";

/**
 * Chat detection, driven through main.lua.
 *
 * Every bug this file covers was a LIFECYCLE bug rather than a reading bug: a
 * scan window that closed too early and read only the first box, and a
 * readability verdict decided per render2d event when each box arrives in an
 * event of its own. Both were found by playing the game and noticing an alert
 * that never fired, which is the slowest possible way to find either.
 *
 * TIMING. A tick opens the scan window; the window covers the NEXT frame and
 * closes at its swap-buffers. So chat must be drawn on the frame after a tick,
 * and its verdict reaches the snapshot on the tick after that.
 */

function tick(plugin: LuaPlugin): void {
  plugin.frame([], TICK_US);
}

/**
 * Show the boxes once and let a tick pass, so they are primed.
 *
 * A box's FIRST read emits nothing: the module reports everything it can see
 * when given no marker, and on first sight that is history — messages already on
 * screen before anyone was watching. Every test that expects a message therefore
 * has to establish the box first, exactly as the plugin does at startup.
 */
function prime(plugin: LuaPlugin, ...at: Array<{ x: number; y: number }>): void {
  tick(plugin);
  plugin.frame(at.map((p) => chatBox(p, { messages: [] })));
  tick(plugin);
}

/**
 * A chat line as the game really delivers it.
 *
 * Bolt's chat module assembles each message one GLYPH at a time, and a space has
 * no glyph — it produces no vertex, so it is simply absent. "A Seren spirit
 * appears" arrives as "ASerenspiritappears". A fixture written with spaces in it
 * would be testing a string the game never sends, which is how 74 chat alerts
 * came to be configured with text that could never match anything. These two
 * helpers keep the tests readable while sending what the module actually sends.
 */
function said(at: string, text: string): string {
  return `[${at}]${heard(text)}`;
}

/** The same line as it reaches the browser: timestamp stripped, spaces never there. */
function heard(text: string): string {
  return text.replaceAll(" ", "");
}

/** Every chat line the plugin has sent, in order. */
function lines(plugin: LuaPlugin): string[] {
  return plugin
    .sent()
    .filter((m) => m.t === "chat")
    .flatMap((m) => (m as SentMessage & { lines: Array<{ text: string }> }).lines)
    .map((l) => l.text);
}

describe("chat reading", () => {
  it("reads a message and strips its timestamp", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 });
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "A Seren spirit appears")] })]);
    tick(plugin);

    expect(lines(plugin)).toEqual([heard("A Seren spirit appears")]);

    plugin.close();
  });

  /**
   * AfkWarden read one box and silently ignored the rest, so an alert set
   * against a filtered tab looked configured and never fired. Each box arrives
   * in its own render2d event, so this only works if the scan window spans the
   * whole frame.
   */
  it("reads every open chat box, not just the first", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 }, { x: 600, y: 400 });
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "said in the first box")] }),
      chatBox({ x: 600, y: 400 }, { messages: [said("12:00:02", "said in the second box")] }),
    ]);
    tick(plugin);

    expect(lines(plugin)).toEqual([heard("said in the first box"), heard("said in the second box")]);
    expect(plugin.latest()?.chatBoxes).toBe(2);

    plugin.close();
  });

  /** The same line showing in two tabs is one event, not two alerts. */
  it("emits a message shown in two boxes only once", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 }, { x: 600, y: 400 });
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "you feel refreshed")] }),
      chatBox({ x: 600, y: 400 }, { messages: [said("12:00:01", "you feel refreshed")] }),
    ]);
    tick(plugin);

    expect(lines(plugin)).toEqual([heard("you feel refreshed")]);

    plugin.close();
  });

  /** Each box carries its own history, so one box's marker must not gag another. */
  it("does not let one box suppress another box's messages", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 }, { x: 600, y: 400 });
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "first")] }),
      chatBox({ x: 600, y: 400 }, { messages: [said("12:00:02", "second")] }),
    ]);
    tick(plugin);
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "first"), said("12:00:03", "third")] }),
      chatBox({ x: 600, y: 400 }, { messages: [said("12:00:02", "second")] }),
    ]);
    tick(plugin);

    expect(lines(plugin)).toEqual(["first", "second", "third"]);

    plugin.close();
  });

  /**
   * A box's first read is history, not news.
   *
   * The module reports everything it can see when handed no marker, so a box
   * seen for the first time replays the whole visible log — firing alerts for
   * things that happened before anyone was watching.
   */
  it("emits nothing for the messages already on screen when a box first appears", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "old one"), said("12:00:02", "old two")] }),
    ]);
    tick(plugin);

    expect(lines(plugin)).toEqual([]);

    plugin.close();
  });

  /**
   * REPRODUCES WHAT WAS SEEN IN GAME: the quick-chat icon beside a player's name
   * is the same 11x11 sprite as a chat box's anchor, so it reads as a box of its
   * own — and it MOVES as the log scrolls, so every new position was a brand-new
   * box replaying every message on screen. Boxes come and go for ordinary
   * reasons too: resizing an interface moves the anchor and would do the same.
   */
  it("does not replay the log when an anchor appears at a new position", async () => {
    const plugin = await loadPlugin();

    const history = [said("12:00:01", "one"), said("12:00:02", "two"), said("12:00:03", "three")];

    prime(plugin, { x: 20, y: 400 });
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: history })]);
    tick(plugin);
    expect(lines(plugin)).toEqual(["one", "two", "three"]);

    // The same log, seen through an anchor that has shifted a few pixels.
    plugin.frame([chatBox({ x: 24, y: 396 }, { messages: history })]);
    tick(plugin);

    expect(lines(plugin)).toEqual(["one", "two", "three"]);

    plugin.close();
  });

  /**
   * The scan reads the atlas entry of every image in every batch — around 3,300
   * per frame in a live client, per detector — so running it on every frame of
   * every tick cost five to ten FPS. It runs for the first slice of each tick
   * only.
   *
   * Bounded by TIME, not by a frame count: Bolt gives no reliable frame
   * boundary, and assuming it did is what made chat blind for two sessions.
   */
  it("declines to scan batches once the tick's budget has elapsed", async () => {
    const plugin = await loadPlugin();
    const box = chatBox({ x: 20, y: 400 }, { messages: [] });

    prime(plugin, { x: 20, y: 400 });

    // One frame inside the budget, then a frame well past it.
    plugin.frame([box]);
    plugin.frame([box], 200_000);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.render2dEvents).toBe(2);
    expect(diag?.render2dScanned).toBe(1);
    // Declining work must not cost the reading: the box was still found.
    expect(diag?.chatConfirmed).toBe(1);

    plugin.close();
  });

  /**
   * The budget has to cover a whole frame on a SLOW client, where a frame is
   * long. Anything on screen is drawn every frame, so one complete pass sees all
   * of it — but only if the window outlasts a frame.
   */
  it("covers a complete frame even at fifteen frames per second", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 }, { x: 600, y: 400 });

    // 66ms per frame. Both boxes are drawn in the same frame, one early and one
    // after a long run of other batches.
    plugin.frame(
      [
        chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "early")] }),
        ...Array.from({ length: 30 }, () => ({
          kind: "render2d" as const,
          images: [{ aw: 4, ah: 4, x: 1, y: 1 }],
        })),
        chatBox({ x: 600, y: 400 }, { messages: [said("12:00:02", "late")] }),
      ],
      66_000,
    );
    tick(plugin);

    expect(lines(plugin)).toEqual([heard("early"), heard("late")]);
    expect(plugin.latest()?.diag.chatConfirmed).toBe(2);

    plugin.close();
  });

  it("sends nothing when nobody has spoken", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [] })]);
    tick(plugin);

    expect(plugin.sent().filter((m) => m.t === "chat")).toHaveLength(0);

    plugin.close();
  });
});

describe("chat readability", () => {
  it("reports chat readable once a box has been read", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [] })]);
    tick(plugin);

    expect(plugin.latest()?.chatAvailable).toBe(true);
    expect(plugin.latest()?.chatScrolledUp).toBe(false);

    plugin.close();
  });

  /**
   * The verdict used to be decided per render2d event, so whichever box happened
   * to render LAST decided for all of them — and scrolling one box up to read
   * history silenced every alert watching the other.
   */
  it("stays readable when one box is scrolled up and another is not", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 }, { x: 600, y: 400 });
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "still visible")] }),
      chatBox({ x: 600, y: 400 }, { scrolled: true }),
    ]);
    tick(plugin);

    expect(plugin.latest()?.chatAvailable).toBe(true);
    expect(plugin.latest()?.chatScrolledUp).toBe(false);
    expect(lines(plugin)).toEqual([heard("still visible")]);

    plugin.close();
  });

  it("reports scrolled up only when every box is scrolled up", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { scrolled: true }),
      chatBox({ x: 600, y: 400 }, { scrolled: true }),
    ]);
    tick(plugin);

    expect(plugin.latest()?.chatScrolledUp).toBe(true);
    expect(plugin.latest()?.chatAvailable).toBe(false);

    plugin.close();
  });

  /**
   * A frame that draws no chat says nothing about readability. Treating it as
   * "unreadable" would flicker the verdict every time chat happened not to
   * redraw, and a flickering verdict silences alerts at random.
   */
  it("does not go blind on a frame that draws no chat at all", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [] })]);
    tick(plugin);
    expect(plugin.latest()?.chatAvailable).toBe(true);

    plugin.idle(4);
    tick(plugin);
    expect(plugin.latest()?.chatAvailable).toBe(true);

    plugin.close();
  });

  /**
   * REPRODUCES WHAT WAS SEEN IN GAME: chat alerts firing while the plugin
   * reported it had never once found a chat box.
   *
   * Detection used to open a scan window at the tick and close it at the next
   * swap-buffers. Bolt raises that event on every buffer swap the client makes,
   * and the client makes as many as it likes — so with more than one per frame
   * the window opened and closed before a single render2d event arrived, and
   * chat was never scanned at all. Buffs stopped using the window and started
   * working; chat still used it and reported nothing. That was the tell.
   */
  it("reads chat when the client swaps buffers more than once per frame", async () => {
    const plugin = await loadPlugin();
    plugin.setSwapsPerFrame(2);

    prime(plugin, { x: 20, y: 400 });
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "a Seren spirit appears")] })]);
    tick(plugin);

    expect(lines(plugin)).toEqual([heard("a Seren spirit appears")]);
    expect(plugin.latest()?.chatAvailable).toBe(true);
    expect(plugin.latest()?.diag.chatBubbles).toBe(1);

    plugin.close();
  });

  it("reports chat unreadable before any box has been seen", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.idle(3);
    tick(plugin);

    expect(plugin.latest()?.chatAvailable).toBe(false);

    plugin.close();
  });
});

describe("chat diagnostics", () => {
  /**
   * These distinguish "the anchor never matched anything" from "the anchor
   * matched but the reader rejected it" — a wrong constant in Lua versus a game
   * setting the user can change. The old UI reported both as the second.
   */
  it("separates anchors found from boxes confirmed", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "real chat")] }),
      // An 11x11 image that is not chat at all: the reader declines it.
      { kind: "render2d", images: [{ aw: 11, ah: 11, x: 900, y: 90 }] },
    ]);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.chatBubbles).toBe(2);
    expect(diag?.chatConfirmed).toBe(1);
    expect(diag?.chatScrolledBoxes).toBe(0);

    plugin.close();
  });

  /**
   * "Found 2, reading 1" is ambiguous, and it was asked about the moment it
   * appeared. An 11x11 image is a loose filter, so a rejected anchor is usually
   * something else on screen entirely — but it could equally be a real chat box
   * being missed, and those need opposite responses. The positions say which.
   */
  it("reports where each anchor was and what became of it", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 });
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "real chat")] }),
      { kind: "render2d", images: [{ aw: 11, ah: 11, x: 900, y: 90 }] },
    ]);
    tick(plugin);

    const anchors = plugin.latest()?.diag.chatAnchors ?? [];
    expect(anchors).toHaveLength(2);
    // The batch each anchor arrived in comes back too: a real chat box is one
    // batch, so two anchors sharing a batch are one box and something inline
    // within it — a quick-chat icon, say — rather than two boxes.
    expect(anchors).toContainEqual(
      expect.objectContaining({ at: "20,400", ischat: true, scrolled: false, event: 1 }),
    );
    expect(anchors).toContainEqual(
      expect.objectContaining({ at: "900,90", ischat: false, scrolled: false, event: 2 }),
    );

    plugin.close();
  });

  it("counts scrolled boxes and the messages handed over", async () => {
    const plugin = await loadPlugin();

    prime(plugin, { x: 20, y: 400 }, { x: 600, y: 400 });
    plugin.frame([
      chatBox({ x: 20, y: 400 }, { messages: [said("12:00:01", "one"), said("12:00:02", "two")] }),
      chatBox({ x: 600, y: 400 }, { scrolled: true }),
    ]);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.chatScrolledBoxes).toBe(1);
    expect(diag?.chatLines).toBe(2);

    plugin.close();
  });

  /**
   * A scan window is one frame. Chat found earlier but not on the frame just
   * checked is a different problem from chat never found — it means messages are
   * being missed rather than that nothing is configured.
   */
  it("remembers that chat was found even after a frame that drew none", async () => {
    const plugin = await loadPlugin();

    tick(plugin);
    plugin.frame([chatBox({ x: 20, y: 400 }, { messages: [] })]);
    tick(plugin);
    plugin.idle(3);
    tick(plugin);

    const diag = plugin.latest()?.diag;
    expect(diag?.chatBubbles).toBe(0);
    expect(diag?.chatBubblesEver).toBe(1);
    expect(diag?.chatConfirmedEver).toBe(1);

    plugin.close();
  });
});
