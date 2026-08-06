import { z } from "zod";

/**
 * The wire contract between the Lua plugin and this app.
 *
 * Lua runs inside the game process; a malformed message must degrade to "no
 * data" rather than throwing into the UI, so every decode is fallible by design.
 *
 * Note what is absent: a clock. `bolt.time()` is monotonic microseconds from an
 * arbitrary origin, and overflows roughly hourly on a 32-bit CPU, so it is not a
 * wall clock and must never be treated as one. Lua therefore sends only
 * DURATIONS, in milliseconds, and the browser stamps its own `Date.now()` on
 * receipt. This is the same trap as AfkWarden's `rsLastActive` -- a number that
 * reads like a timestamp and is not one -- kept out of the protocol by shape
 * rather than by comment.
 */

/** A 0..1 resource level. Out-of-range means Lua misread, so reject rather than clamp. */
const Fraction = z.number().min(0).max(1);

export const StatsSchema = z.object({
  hp: Fraction,
  pray: Fraction,
  sum: Fraction,
  dren: Fraction,
});

export const BuffSlotSchema = z.object({
  /**
   * Stable buff name, e.g. "overload". Replaces Alt1's captured needle image:
   * Bolt matches the game's texture atlas, so identity is a name, not a bitmap.
   */
  id: z.string().min(1),
  /** Remaining seconds, or null when the timer text is unreadable. */
  timeLeft: z.number().nullable(),
  /** The parenthesised number some buffs carry, or null when absent. */
  stacks: z.number().nullable(),
});

export const PlayerSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const StateMessageSchema = z.object({
  t: z.literal("state"),
  tick: z.number().int().nonnegative(),
  /** Milliseconds since the last mouse click. A duration, not a timestamp. */
  clickIdleMs: z.number().nonnegative(),
  /** Milliseconds since the last mouse motion or scroll. A duration. */
  mouseIdleMs: z.number().nonnegative(),
  /**
   * WARNING: unreliable on Windows, where Bolt reports focus with `GetFocus()`
   * — which only sees the focus window if it belongs to the CALLING THREAD's
   * message queue, and Lua runs on the render thread. It is therefore always
   * false there. Linux tracks XCB focus events properly. Do not build behaviour
   * that fails dangerously when this is wrong.
   */
  focused: z.boolean(),
  loggedIn: z.boolean(),
  /**
   * The logged-in character's DISPLAY name, or null in the lobby.
   *
   * Deliberately the name and not `bolt.characterid()`. The id is an opaque
   * hash that Bolt's own docs ask callers to treat as private, and it is what
   * names the on-disk config file — right for keying storage, wrong to put in
   * a UI. Lua keeps using the id internally for config paths and never sends it.
   *
   * Lives on the snapshot rather than the startup handshake because it is only
   * knowable after login, which happens long after the plugin starts.
   */
  characterName: z.string().nullable().default(null),
  /**
   * Null when Lua could not read the bars, which is distinct from all-zero.
   *
   * Defaulted rather than merely nullable because assigning nil to a Lua table
   * field deletes the key: "unreadable" reaches us as an ABSENT field, never as
   * an explicit null. The required scalars above are deliberately NOT defaulted
   * — a missing `clickIdleMs` is a plugin bug and must fail loudly rather than
   * decode as a plausible zero.
   */
  stats: StatsSchema.nullable().default(null),
  buffs: z.array(BuffSlotSchema).default([]),
  debuffs: z.array(BuffSlotSchema).default([]),
  player: PlayerSchema.nullable().default(null),
  /** Model ids identified on screen this tick. */
  models: z.array(z.string()).default([]),
  craftProgress: Fraction.nullable().default(null),
});

/** Matches the engine's existing `ChatLine`: a line split into per-colour fragments. */
export const ChatLineSchema = z.object({
  text: z.string(),
  colors: z.array(z.tuple([z.number(), z.number(), z.number()])),
  fragments: z.array(z.string()),
});

export const ChatMessageSchema = z.object({
  t: z.literal("chat"),
  /** New lines across every monitored chatbox, already deduped by Lua. */
  lines: z.array(ChatLineSchema),
});

export const XpMessageSchema = z.object({
  t: z.literal("xp"),
  /** AfkWarden's 3-letter skill code, e.g. "div", or "tot" for total. */
  skill: z.string().min(1),
  amount: z.number(),
});

/** Sent once at startup. Purely the API version handshake — see `character` on state. */
export const HelloMessageSchema = z.object({
  t: z.literal("hello"),
  apiVersion: z.tuple([z.number(), z.number()]),
});

/**
 * The stored config blob, handed over once at startup.
 *
 * Lua owns persistence but never parses this — it round-trips the string
 * verbatim — so the schema for its contents stays in one place, here in the app.
 */
export const ConfigMessageSchema = z.object({
  t: z.literal("config"),
  data: z.string(),
});

export const PluginMessageSchema = z.discriminatedUnion("t", [
  StateMessageSchema,
  ChatMessageSchema,
  XpMessageSchema,
  HelloMessageSchema,
  ConfigMessageSchema,
]);

export type Stats = z.infer<typeof StatsSchema>;
export type BuffSlot = z.infer<typeof BuffSlotSchema>;
export type ChatLine = z.infer<typeof ChatLineSchema>;
export type StateMessage = z.infer<typeof StateMessageSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type XpMessage = z.infer<typeof XpMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ConfigMessage = z.infer<typeof ConfigMessageSchema>;
export type PluginMessage = z.infer<typeof PluginMessageSchema>;

/**
 * Decode one message delivered by `browser:sendmessage`.
 *
 * Returns null for anything unreadable — bad UTF-8, bad JSON, or a shape the
 * schema rejects — so a plugin bug cannot take the UI down with it.
 */
export function decodePluginMessage(data: ArrayBuffer): PluginMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }

  const result = PluginMessageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
