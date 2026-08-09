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
  /**
   * Remaining seconds, or null when no timer text is showing.
   *
   * DEFAULTED, not merely nullable, and the difference is load-bearing. Lua
   * deletes a table key assigned nil, so an absent number reaches us as a
   * MISSING FIELD and never as an explicit null. A nullable-only field rejects
   * that, and one rejected buff fails the whole snapshot — which shows up as the
   * plugin going silent the moment an ordinary buff appears, not as a buff with
   * a missing timer. Same trap the `stats` field below documents.
   */
  timeLeft: z.number().nullable().default(null),
  /** The parenthesised number some buffs carry, or null when absent. See above. */
  stacks: z.number().nullable().default(null),
  /**
   * Position on the bar, left to right, 1-based. 0 when unknown.
   *
   * The picker's only handle on which entry is which. Ids are opaque by
   * construction — a model signature or a hash of the icon's pixels — so "the
   * third one along" is the one description that matches what is on screen.
   * Counted across buffs and debuffs together, because they share the bar.
   */
  slot: z.number().int().nonnegative().default(0),
  /**
   * Which detection path found this buff.
   *
   * Published so the blind spot is measurable per buff rather than only as the
   * aggregate difference between outlines and buffs read. "icon" means Bolt
   * recognised a rendered item model and announced it; "sprite" means it was
   * found by reading the draw stream directly, which is the only way abilities,
   * prayers and familiars can be seen at all.
   */
  source: z.enum(["icon", "sprite", "unknown"]).default("unknown"),
});

export const PlayerSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const TargetSchema = z.object({
  name: z.string(),
  /** Remaining health as a 0..1 fraction. */
  hp: Fraction,
});

export const DropEventSchema = z.object({
  name: z.string(),
  amount: z.number(),
});

/**
 * What detection actually saw on the last tick.
 *
 * Every field is a count, and the interesting readings are the zeroes. An alert
 * that never fires has a small number of distinguishable causes and they need
 * completely different fixes — a wrong anchor constant in Lua, a game setting,
 * or simply nothing having happened — and none of them are visible from the
 * outside. This is the surface that tells them apart, and it is the reason the
 * UI can say something more useful than "not working".
 *
 * Wholly defaulted, so an older plugin against a newer UI degrades to zeroes
 * rather than refusing to decode the snapshot it is attached to.
 */
export const DiagnosticsSchema = z.object({
  /** 11x11 speech-bubble anchors found in the scanned frame. Zero means the anchor is wrong. */
  chatBubbles: z.number().int().nonnegative().default(0),
  /** Anchors the chat module confirmed as a real chat box. */
  chatConfirmed: z.number().int().nonnegative().default(0),
  /** Confirmed boxes that were scrolled up, so their newest messages are off-screen. */
  chatScrolledBoxes: z.number().int().nonnegative().default(0),
  /**
   * High-water marks over the session. A scan window is a single frame, so a
   * zero above with a non-zero mark here means chat is found intermittently
   * rather than never — a different problem with a different fix.
   */
  chatBubblesEver: z.number().int().nonnegative().default(0),
  chatConfirmedEver: z.number().int().nonnegative().default(0),
  /** Messages handed over on the last tick. Zero is normal — nobody spoke. */
  chatLines: z.number().int().nonnegative().default(0),
  /**
   * render2d events detection was fed during the last tick.
   *
   * The one number that separates "looked and found nothing" from "never got to
   * look". A zero here with the plugin otherwise connected means detection is
   * not running at all, whatever the other counts say.
   */
  render2dEvents: z.number().int().nonnegative().default(0),
  /**
   * Of those, how many were actually walked.
   *
   * Chat and the action bar are scanned for only the first slice of each tick,
   * because walking every image of every batch on every frame costs real FPS.
   * The ratio is the cost of detection, and it is published so that "cheaper" is
   * a measurement rather than a hope.
   */
  render2dScanned: z.number().int().nonnegative().default(0),
  /**
   * EVERY icon the game drew last tick, not just buff icons: inventory and
   * interface items arrive through the same event. Zero means `onrendericon` is
   * not firing at all, which is a different order of problem from a buff icon
   * whose timer will not parse.
   */
  buffIconDraws: z.number().int().nonnegative().default(0),
  /** Icons that parsed as a buff or debuff. This IS the buff count. */
  buffIconsRead: z.number().int().nonnegative().default(0),
  /**
   * Pairing attempts made against buff icons last tick.
   *
   * The cost of carrying unmatched icons across batches while looking for their
   * timer text. Published so the bound on that search stays a measured decision:
   * raising it is what let a full buff bar be read, and this is what would show
   * if it were ever raised too far.
   */
  buffPairAttempts: z.number().int().nonnegative().default(0),
  /**
   * Buff icons that were drawn but whose timer text never turned up.
   *
   * Four icons on the bar and three read leaves one question open, and only the
   * plugin knows which one it dropped. This names it and says where it was.
   */
  buffUnpaired: z
    .array(
      z.object({
        id: z.string(),
        x: z.number(),
        y: z.number(),
        /**
         * Times this same icon was given up on during the tick.
         *
         * The bar is redrawn every frame, so one icon that never pairs is given
         * up on once per frame. Without this the list was twelve copies of one
         * icon and had no room left to show a second.
         */
        count: z.number().int().positive().default(1),
        /**
         * The error the buff module raised, when it raised one.
         *
         * Null is the common case and does NOT mean "no timer": the module has
         * several silent ways to decline an icon — the outline not being where
         * it was told, a colour that is not one of its two, a glyph it cannot
         * resolve — and a raise is the only one that explains itself.
         */
        err: z.string().nullable().default(null),
      }),
    )
    .default([]),
  /**
   * Distinct buff/debuff outline boxes drawn last tick.
   *
   * Compare against the icons on the bar. Bolt raises an icon event only for
   * images it recognised as a rendered 3D item model, so a buff drawn from a
   * plain authored sprite raises none and is invisible to detection however well
   * the pairing works. Every buff is outlined, so the difference is the size of
   * that blind spot.
   */
  buffOutlines: z.number().int().nonnegative().default(0),
  /**
   * Sprite ids derived this session, with the atlas rectangle behind each.
   *
   * A sprite-drawn buff is identified by hashing its icon, because atlas rects
   * are packed at runtime and do not survive a session. Whether the atlas holds
   * one variant per sprite or one per interface scale has never been read out of
   * a live draw stream — so this is the reading that would show an id changing
   * when it should not, which would otherwise surface only as an alert that
   * quietly stopped firing.
   */
  buffIdentities: z
    .array(
      z.object({
        id: z.string(),
        /** Atlas rectangle as "x,y,w,h". */
        atlas: z.string().default(""),
        w: z.number().default(0),
        h: z.number().default(0),
      }),
    )
    .default([]),
  /** How many of the four action-bar resource bars were read, out of four. */
  barsRead: z.number().int().nonnegative().default(0),
  /**
   * Where each chat anchor candidate was, and what became of it.
   *
   * "Found 2, reading 1" is ambiguous on its own: an 11x11 image is a loose
   * filter, so the rejected one is usually not a chat box at all — but it could
   * equally be a real box being missed. This says which, and where.
   */
  chatAnchors: z
    .array(
      z.object({
        /** Screen position of the anchor, as "x,y". */
        at: z.string(),
        ischat: z.boolean().default(false),
        scrolled: z.boolean().default(false),
        /** Atlas entry it was drawn from, as "x,y". Two anchors from different
         *  sprites are different things wearing the same size. */
        sprite: z.string().default(""),
        /** Which render2d batch it arrived in. One batch is one chat box. */
        event: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),
});

export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

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
  /**
   * Whether chat could be read on the last scan.
   *
   * Defaults FALSE, unlike the detection fields above: chat requires message
   * timestamps to be enabled in game, and a plugin that says nothing about chat
   * has not read any. Claiming otherwise would make every chat alert look
   * healthy while blind.
   */
  chatAvailable: z.boolean().default(false),
  /** Chat box scrolled up, so new messages are off-screen and unreadable. */
  chatScrolledUp: z.boolean().default(false),
  /** How many chat boxes are being read. Every open box is monitored, not just one. */
  chatBoxes: z.number().int().nonnegative().default(0),
  /**
   * The next three have no detection yet — they land later in Phase 2. They
   * default to null rather than to a false or an empty list on purpose: "not
   * implemented" has to read as "cannot see", so the alerters that depend on
   * them report `functional: false` instead of confidently reporting that
   * nothing is happening.
   */
  dialogOpen: z.boolean().nullable().default(null),
  target: TargetSchema.nullable().default(null),
  newDrops: z.array(DropEventSchema).nullable().default(null),
  /** See `DiagnosticsSchema`. Defaulted whole, so it is always present. */
  diag: DiagnosticsSchema.default(() => DiagnosticsSchema.parse({})),
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

/**
 * One tick of the draw stream, described rather than interpreted.
 *
 * Every detector identifies its target by a constant someone guessed at, and a
 * wrong guess produces an ABSENT reading rather than a wrong one — which looks
 * exactly like an empty screen. This is what tells those apart: it reports the
 * shapes and colours the game actually drew, so "there is no 106x4 image, but
 * there is an 89x4 flat quad in that colour" becomes an answer instead of
 * another guess. Requested from the UI; see lua/detect/probe.lua.
 */
export const ProbeMessageSchema = z.object({
  t: z.literal("probe"),
  /**
   * Distinct shapes drawn, commonest first, each with where it was first drawn.
   *
   * The position is what turns a size into a location: "six 27x27 images at
   * y=990" identifies a buff bar, where a bare count of 27x27 images identifies
   * nothing at all.
   */
  shapes: z
    .array(z.object({ key: z.string(), count: z.number(), x: z.number().default(0), y: z.number().default(0) }))
    .default([]),
  /**
   * Every wide, thin image, with both readings of its colour and its drawn width.
   *
   * The action bar's four bars are this shape. They read as invisible while
   * sitting in the draw stream every frame, which means the palette is wrong
   * somewhere — and a sprite's texture and its vertex tint disagree whenever the
   * sprite is shared and tinted per use, so both are reported rather than one
   * being assumed correct.
   */
  bars: z
    .array(
      z.object({
        atlas: z.string(),
        x: z.number(),
        y: z.number(),
        /** Width on screen. This IS the fill reading — see FILL_W in stats.lua. */
        drawn: z.number(),
        texture: z.string(),
        tint: z.string(),
      }),
    )
    .default([]),
  /** Every icon draw, in order, with the signature buff detection derived for it. */
  icons: z
    .array(
      z.object({
        id: z.string().nullable().default(null),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      }),
    )
    .default([]),
  /** Whether a cap was hit, so a short list is not mistaken for a complete one. */
  truncated: z.boolean().default(false),
});

export const PluginMessageSchema = z.discriminatedUnion("t", [
  StateMessageSchema,
  ChatMessageSchema,
  XpMessageSchema,
  HelloMessageSchema,
  ConfigMessageSchema,
  ProbeMessageSchema,
]);

export type Stats = z.infer<typeof StatsSchema>;
export type BuffSlot = z.infer<typeof BuffSlotSchema>;
export type Player = z.infer<typeof PlayerSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type DropEvent = z.infer<typeof DropEventSchema>;
export type ChatLine = z.infer<typeof ChatLineSchema>;
export type StateMessage = z.infer<typeof StateMessageSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type XpMessage = z.infer<typeof XpMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ConfigMessage = z.infer<typeof ConfigMessageSchema>;
export type ProbeMessage = z.infer<typeof ProbeMessageSchema>;
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
