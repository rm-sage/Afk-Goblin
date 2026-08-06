import { describe, expect, it } from "vitest";
import { loginGate } from "~/engine/login-gate";

describe("loginGate", () => {
  it("holds alerts when no character is logged in", () => {
    const r = loginGate({ loggedIn: false, connected: true }, true);
    expect(r.held).toBe(true);
    if (r.held) expect(r.reason).toMatch(/logged out|lobby/i);
  });

  it("lets alerts through while logged in", () => {
    expect(loginGate({ loggedIn: true, connected: true }, true).held).toBe(false);
  });

  it("does nothing when the setting is off", () => {
    expect(loginGate({ loggedIn: false, connected: true }, false).held).toBe(false);
  });

  // When the plugin is not talking to us we do not know whether the player is
  // logged in, and a wrong "logged out" would silence every alert -- the failure
  // this app exists to prevent. Not knowing must never be treated as knowing.
  it("fails open when the plugin is not connected", () => {
    expect(loginGate({ loggedIn: false, connected: false }, true).held).toBe(false);
  });
});
