import { describe, expect, it } from "vitest";
import { listenForPlugin } from "~/bolt-io/host";
import { SnapshotStore } from "~/bolt-io/snapshot";

const STATE = {
  t: "state",
  tick: 1,
  clickIdleMs: 0,
  mouseIdleMs: 0,
  focused: true,
  loggedIn: true,
  characterName: "Sage",
};

function content(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function setup() {
  const target = new EventTarget();
  const store = new SnapshotStore(() => 1000);
  const stop = listenForPlugin(store, target);
  const post = (data: unknown) => target.dispatchEvent(new MessageEvent("message", { data }));
  return { store, stop, post };
}

describe("listenForPlugin", () => {
  it("feeds a plugin message into the store", () => {
    const { store, post } = setup();

    post({ type: "pluginMessage", content: content(STATE) });

    expect(store.characterName).toBe("Sage");
  });

  // Bolt sends screen captures over the same channel. Reading one as a plugin
  // message would mean decoding raw RGB pixels as JSON on every captured frame.
  it("ignores messages that are not plugin messages", () => {
    const { store, post } = setup();

    post({ type: "screenCapture", width: 2, height: 2, content: content(STATE) });

    expect(store.characterName).toBeNull();
    expect(store.connected).toBe(false);
  });

  it("ignores event data that is not an object", () => {
    const { store, post } = setup();

    post("just a string");

    expect(store.connected).toBe(false);
  });

  it("ignores a plugin message whose content will not decode", () => {
    const { store, post } = setup();

    post({ type: "pluginMessage", content: new TextEncoder().encode("nonsense").buffer });

    expect(store.connected).toBe(false);
  });

  it("stops delivering once unsubscribed", () => {
    const { store, stop, post } = setup();
    stop();

    post({ type: "pluginMessage", content: content(STATE) });

    expect(store.characterName).toBeNull();
  });
});
