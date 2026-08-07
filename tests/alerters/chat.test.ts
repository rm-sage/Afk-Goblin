import { describe, expect, it } from "vitest";
import { chatAlerter, ChatVars } from "~/alerters/chat";
import type { AlerterContext, ChatLine, RGB } from "~/engine/types";
import { NO_STATE } from "~/engine/types";

function line(text: string, ...colors: RGB[]): ChatLine {
  return { text, colors: colors.length > 0 ? colors : [[255, 255, 255]], fragments: [text] };
}

function ctx(over: Partial<AlerterContext> = {}): AlerterContext {
  return { tick: 1, now: 1_000_000, idleMs: 999_999, mouseIdleMs: 999_999, connected: true, chatLines: [], chatAvailable: true, state: NO_STATE, ...over };
}

const serenVars = {
  lines: [{ text: "A Seren spirit appears", percent: 100 }],
  colors: [[0, 255, 255]] as RGB[],
  resetonactive: true,
};

describe("chatAlerter", () => {
  it("triggers on an exact line", () => {
    const a = chatAlerter.create(serenVars);
    const r = a.check(ctx({ chatLines: [line("A Seren spirit appears", [0, 255, 255])] }));
    expect(r.triggered).toBe(true);
    expect(r.bar).toBe(1);
  });

  // Real presets are written as fragments of longer messages, e.g.
  // "has gained a level! It is now level 2".
  it("matches a substring of a longer line", () => {
    const a = chatAlerter.create(serenVars);
    const hit = line("[19:04:22] A Seren spirit appears nearby!", [0, 255, 255]);
    expect(a.check(ctx({ chatLines: [hit] })).triggered).toBe(true);
  });

  it("matches case-insensitively", () => {
    const a = chatAlerter.create(serenVars);
    expect(
      a.check(ctx({ chatLines: [line("a seren SPIRIT appears", [0, 255, 255])] })).triggered,
    ).toBe(true);
  });

  it("does not trigger on a non-matching line", () => {
    const a = chatAlerter.create(serenVars);
    expect(a.check(ctx({ chatLines: [line("You mine some ore.", [0, 255, 255])] })).triggered).toBe(
      false,
    );
  });

  it("respects the colour filter", () => {
    const a = chatAlerter.create(serenVars);
    // Right text, wrong colour.
    expect(
      a.check(ctx({ chatLines: [line("A Seren spirit appears", [255, 0, 0])] })).triggered,
    ).toBe(false);
  });

  it("accepts any colour when no filter is set", () => {
    const a = chatAlerter.create({ ...serenVars, colors: [] });
    expect(
      a.check(ctx({ chatLines: [line("A Seren spirit appears", [123, 45, 6])] })).triggered,
    ).toBe(true);
  });

  it("ORs across multiple configured lines", () => {
    const a = chatAlerter.create({
      lines: [
        { text: "nest falls", percent: 100 },
        { text: "A geode falls", percent: 100 },
      ],
      colors: [],
      resetonactive: true,
    });
    expect(a.check(ctx({ chatLines: [line("A geode falls out of the tree")] })).triggered).toBe(true);
  });

  it("stays triggered across ticks until reset", () => {
    const a = chatAlerter.create(serenVars);
    a.check(ctx({ chatLines: [line("A Seren spirit appears", [0, 255, 255])] }));
    expect(a.check(ctx({ chatLines: [] })).triggered).toBe(true);
  });

  // Both quantities are "milliseconds since": idleMs since the last click, and
  // (now - triggeredAt) since the alert fired. The smaller one happened later.
  it("clears when the player clicks after the alert fired", () => {
    const a = chatAlerter.create(serenVars);
    a.check(
      ctx({
        now: 1_000_000,
        idleMs: 900_000,
        chatLines: [line("A Seren spirit appears", [0, 255, 255])],
      }),
    );
    // 5s later, last click was 1s ago -- i.e. after the alert. Clear it.
    expect(a.check(ctx({ now: 1_005_000, idleMs: 1_000 })).triggered).toBe(false);
  });

  it("stays triggered while the player remains idle", () => {
    const a = chatAlerter.create(serenVars);
    a.check(
      ctx({
        now: 1_000_000,
        idleMs: 900_000,
        chatLines: [line("A Seren spirit appears", [0, 255, 255])],
      }),
    );
    // 5s later, still no click since long before the alert. Keep it firing.
    expect(a.check(ctx({ now: 1_005_000, idleMs: 905_000 })).triggered).toBe(true);
  });

  it("stays triggered through activity when resetonactive is off", () => {
    const a = chatAlerter.create({ ...serenVars, resetonactive: false });
    a.check(
      ctx({
        now: 1_000_000,
        idleMs: 900_000,
        chatLines: [line("A Seren spirit appears", [0, 255, 255])],
      }),
    );
    expect(a.check(ctx({ now: 1_005_000, idleMs: 1_000 })).triggered).toBe(true);
  });

  it("reports non-functional when configured with no match text", () => {
    const a = chatAlerter.create({ lines: [], colors: [], resetonactive: true });
    const r = a.check(ctx({ chatLines: [line("anything")] }));
    expect(r.functional).toBe(false);
    expect(r.triggered).toBe(false);
  });

  // "No matching message" and "I cannot see the chatbox" must not look identical.
  it("reports non-functional when no chatbox is found", () => {
    const a = chatAlerter.create(serenVars);
    const r = a.check(ctx({ chatAvailable: false }));
    expect(r.functional).toBe(false);
    expect(r.triggered).toBe(false);
  });

  it("keeps an existing trigger visible while the chatbox is lost", () => {
    const a = chatAlerter.create(serenVars);
    a.check(ctx({ chatLines: [line("A Seren spirit appears", [0, 255, 255])] }));
    const r = a.check(ctx({ chatAvailable: false }));
    expect(r.triggered).toBe(true);
    expect(r.functional).toBe(false);
  });

  it("reset() clears the triggered state", () => {
    const a = chatAlerter.create(serenVars);
    a.check(ctx({ chatLines: [line("A Seren spirit appears", [0, 255, 255])] }));
    a.reset?.();
    expect(a.check(ctx({ chatLines: [] })).triggered).toBe(false);
  });
});

// Bolt's chat module reads text but reports no colour, and 71 of the 108 alerts
// in the reference config specify colours. Treating "colour unknown" as "colour
// mismatch" would silently disable almost every chat alert — the exact failure
// this project exists to remove. Absent colours must fail OPEN.
describe("chat colour matching when the reader cannot report colours", () => {
  it("still fires an alert configured with colours", () => {
    const a = chatAlerter.create(
      ChatVars.parse({
        lines: [{ text: "Seren spirit", percent: 100 }],
        colors: [[0, 255, 255]],
      }),
    );

    const r = a.check(
      ctx({ chatLines: [{ text: "A Seren spirit appears", colors: [], fragments: [] }] }),
    );

    expect(r.triggered).toBe(true);
  });

  // A line that DOES report a colour is still filtered by it, so nothing is lost
  // if colour extraction is added later.
  it("still rejects a line whose reported colour does not match", () => {
    const a = chatAlerter.create(
      ChatVars.parse({
        lines: [{ text: "Seren spirit", percent: 100 }],
        colors: [[0, 255, 255]],
      }),
    );

    const r = a.check(
      ctx({
        chatLines: [{ text: "A Seren spirit appears", colors: [[255, 0, 0]], fragments: [] }],
      }),
    );

    expect(r.triggered).toBe(false);
  });
});

// Bolt's chat module builds each message one GLYPH at a time, and a space has no
// glyph — it produces no vertex, so it is simply absent from what the module
// returns. Every imported alert was written by a human with spaces in it, so
// matching has to ignore them on both sides or none of the 74 chat alerts in the
// reference config can ever fire.
describe("chat matching against text that lost its spaces", () => {
  it("matches a spaced needle against unspaced text", () => {
    const a = chatAlerter.create(
      ChatVars.parse({ lines: [{ text: "Seren spirit", percent: 100 }], colors: [] }),
    );

    const r = a.check(
      ctx({ chatLines: [{ text: "ASerenspiritappears", colors: [], fragments: [] }] }),
    );

    expect(r.triggered).toBe(true);
  });

  it("still matches when both sides have spaces", () => {
    const a = chatAlerter.create(
      ChatVars.parse({ lines: [{ text: "Seren spirit", percent: 100 }], colors: [] }),
    );

    expect(
      a.check(ctx({ chatLines: [line("A Seren spirit appears")] })).triggered,
    ).toBe(true);
  });

  it("does not match unrelated text just because spaces were removed", () => {
    const a = chatAlerter.create(
      ChatVars.parse({ lines: [{ text: "Seren spirit", percent: 100 }], colors: [] }),
    );

    expect(a.check(ctx({ chatLines: [line("You have run out of energy")] })).triggered).toBe(
      false,
    );
  });
});
