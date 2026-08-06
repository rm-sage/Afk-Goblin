export type LoginState = {
  /** Whether a character is logged in. False on the login screen and in the lobby. */
  loggedIn: boolean;
  /** False when the plugin is not pushing state, which makes `loggedIn` meaningless. */
  connected: boolean;
};

export type GateResult = { held: true; reason: string } | { held: false };

/**
 * Whether alerts should be held because the player is not actually in game.
 *
 * AfkWarden solves this by image-matching the home teleport icon beside the
 * minimap. Alt1 could do better with `currentWorld`, and Bolt better still:
 * `bolt.characterid()` is empty until a character is loaded, so the answer comes
 * from the client itself with no pixel matching and nothing to misread.
 *
 * FAILS OPEN by design. When the plugin is not connected we do not know, and a
 * wrong "logged out" would silence every alert — the exact failure this app
 * exists to prevent. When in doubt, let alerts fire; the UI surfaces the held
 * state so a genuine misread is visible rather than silent.
 */
export function loginGate(state: LoginState, enabled: boolean): GateResult {
  if (!enabled) return { held: false };
  if (!state.connected) return { held: false };
  if (!state.loggedIn) {
    return { held: true, reason: "You appear to be logged out or in the lobby" };
  }
  return { held: false };
}
