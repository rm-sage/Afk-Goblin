import { describe, expect, it } from "vitest";
import { decodePluginMessage } from "~/bolt-io/protocol";

/**
 * Frame a value the way Bolt delivers it.
 *
 * `browser:sendmessage` hands the browser an ArrayBuffer containing the Lua
 * string byte-for-byte, with no decoding, so the decoder must do its own UTF-8.
 */
function frame(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const STATE = {
  t: "state",
  tick: 12,
  clickIdleMs: 4200,
  mouseIdleMs: 900,
  focused: true,
  loggedIn: true,
  stats: { hp: 0.28, pray: 0.91, sum: 1, dren: 0.4 },
  buffs: [{ id: "overload", timeLeft: 27, stacks: null }],
  debuffs: [],
  player: { x: 3221, y: 3218, z: 0 },
  models: ["enrichedspring"],
  craftProgress: null,
};

describe("decodePluginMessage", () => {
  it("decodes a state snapshot", () => {
    const msg = decodePluginMessage(frame(STATE));

    expect(msg).not.toBeNull();
    expect(msg?.t).toBe("state");
    if (msg?.t !== "state") throw new Error("expected a state message");

    expect(msg.tick).toBe(12);
    expect(msg.clickIdleMs).toBe(4200);
    expect(msg.mouseIdleMs).toBe(900);
    expect(msg.stats).toEqual({ hp: 0.28, pray: 0.91, sum: 1, dren: 0.4 });
    expect(msg.buffs).toEqual([{ id: "overload", timeLeft: 27, stacks: null }]);
    expect(msg.player).toEqual({ x: 3221, y: 3218, z: 0 });
    expect(msg.models).toEqual(["enrichedspring"]);
    expect(msg.craftProgress).toBeNull();
  });

  it("decodes a chat message carrying per-colour fragments", () => {
    const msg = decodePluginMessage(
      frame({
        t: "chat",
        lines: [
          {
            text: "Sage: hello there",
            colors: [
              [255, 255, 255],
              [0, 255, 255],
            ],
            fragments: ["Sage:", " hello there"],
          },
        ],
      }),
    );

    if (msg?.t !== "chat") throw new Error("expected a chat message");
    expect(msg.lines).toHaveLength(1);

    const line = msg.lines[0];
    if (line === undefined) throw new Error("expected one chat line");
    expect(line.text).toBe("Sage: hello there");
    expect(line.colors).toEqual([
      [255, 255, 255],
      [0, 255, 255],
    ]);
    expect(line.fragments).toEqual(["Sage:", " hello there"]);
  });

  it("decodes an xp drop naming its skill", () => {
    const msg = decodePluginMessage(frame({ t: "xp", skill: "div", amount: 1200 }));

    if (msg?.t !== "xp") throw new Error("expected an xp message");
    expect(msg.skill).toBe("div");
    expect(msg.amount).toBe(1200);
  });

  // Lua owns persistence but never parses the blob, so the schema lives in one
  // place. It arrives as an opaque string and the store decodes it.
  it("decodes the stored config blob handed over at startup", () => {
    const msg = decodePluginMessage(frame({ t: "config", data: '{"presets":[]}' }));

    if (msg?.t !== "config") throw new Error("expected a config message");
    expect(msg.data).toBe('{"presets":[]}');
  });

  it("decodes the hello handshake", () => {
    const msg = decodePluginMessage(frame({ t: "hello", apiVersion: [1, 0] }));

    if (msg?.t !== "hello") throw new Error("expected a hello message");
    expect(msg.apiVersion).toEqual([1, 0]);
  });

  // The characterName is only knowable after login, which happens long after the
  // plugin starts. Carrying it on the one-shot handshake meant it was always
  // captured as empty, so it belongs on the per-tick snapshot instead.
  it("carries the characterName on the state snapshot", () => {
    const msg = decodePluginMessage(frame({ ...STATE, characterName: "Sage" }));

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.characterName).toBe("Sage");
  });

  it("reads a state with no characterName as null, for the logged-out case", () => {
    const msg = decodePluginMessage(frame(STATE));

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.characterName).toBeNull();
  });
});

// Lua runs inside the game process. Every one of these would otherwise be an
// exception thrown into the UI's message handler, so returning null is the
// behaviour that keeps a plugin bug from taking the app down.
describe("decodePluginMessage, on input it cannot trust", () => {
  it("returns null for bytes that are not JSON", () => {
    const bytes = new TextEncoder().encode("not json at all");
    expect(decodePluginMessage(bytes.buffer as ArrayBuffer)).toBeNull();
  });

  it("returns null for an unknown message type", () => {
    expect(decodePluginMessage(frame({ t: "wat", payload: 1 }))).toBeNull();
  });

  it("returns null when a stat falls outside 0..1", () => {
    expect(
      decodePluginMessage(frame({ ...STATE, stats: { hp: 1.4, pray: 0, sum: 0, dren: 0 } })),
    ).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const { clickIdleMs: _omitted, ...withoutIdle } = STATE;
    expect(decodePluginMessage(frame(withoutIdle))).toBeNull();
  });
});

// Assigning nil to a Lua table field deletes the key rather than storing a null,
// so anything Lua reports as "not readable" arrives as an ABSENT field, not a
// null one. The nullable fields must therefore tolerate absence -- while the
// required scalars above must not, or a Lua bug would decode as a valid zero.
describe("decodePluginMessage, on fields Lua omitted because they were nil", () => {
  it("reads an absent stats block as null", () => {
    const { stats: _omitted, ...withoutStats } = STATE;
    const msg = decodePluginMessage(frame(withoutStats));

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.stats).toBeNull();
  });

  it("reads an absent player position as null", () => {
    const { player: _omitted, ...withoutPlayer } = STATE;
    const msg = decodePluginMessage(frame(withoutPlayer));

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.player).toBeNull();
  });

  // Detection for these lands in Phase 2; until then Lua never sends them, and
  // "not implemented" must decode as "cannot see" rather than as a false.
  it("reads absent dialog, target and drops as unreadable", () => {
    const msg = decodePluginMessage(frame(STATE));

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.dialogOpen).toBeNull();
    expect(msg.target).toBeNull();
    expect(msg.newDrops).toBeNull();
  });

  it("decodes a target and drops when present", () => {
    const msg = decodePluginMessage(
      frame({
        ...STATE,
        dialogOpen: true,
        target: { name: "Kree'arra", hp: 0.42 },
        newDrops: [{ name: "Armadyl hilt", amount: 1 }],
      }),
    );

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.dialogOpen).toBe(true);
    expect(msg.target).toEqual({ name: "Kree'arra", hp: 0.42 });
    expect(msg.newDrops).toEqual([{ name: "Armadyl hilt", amount: 1 }]);
  });

  it("reads absent buff and model lists as empty", () => {
    const { buffs: _b, debuffs: _d, models: _m, ...sparse } = STATE;
    const msg = decodePluginMessage(frame(sparse));

    if (msg?.t !== "state") throw new Error("expected a state message");
    expect(msg.buffs).toEqual([]);
    expect(msg.debuffs).toEqual([]);
    expect(msg.models).toEqual([]);
  });
});
