/**
 * Runs the plugin's Lua inside a real Lua VM.
 *
 * The Lua layer used to be untestable — it only ran inside the game — so its
 * bugs were found by playing RuneScape and noticing an alert that never fired.
 * That is a slow, unreliable and expensive way to learn that a list was cleared
 * one line before it was read. This boots main.lua against a fake Bolt host
 * (see driver.lua) so a frame can be rendered, a tick can pass, and the JSON
 * that would have reached the browser can be asserted on directly.
 *
 * MIND THE DIALECT GAP. This VM is wasmoon, which is Lua 5.4. Bolt's plugin host
 * is LuaJIT 2.1, which is Lua 5.1 — verified from the shipped binary's exported
 * symbols and version banners, not assumed. 5.4 accepts everything 5.1 does and
 * a good deal more, so a passing test here does NOT establish that the plugin
 * will even load.
 *
 * That gap has bitten once, exactly as badly as it sounds: `//`, `~` and `&` in
 * a hash function compiled here and were syntax errors in game, so the plugin
 * died at load and the only symptom was Bolt's enable toggle flipping itself
 * back off. tests/lua/dialect.test.ts now scans for 5.2+ constructs, and CI
 * byte-compiles every file with luajit. Neither of those lives here because this
 * VM cannot express the constraint.
 *
 * (The vendored modules use goto/labels, which is a 5.2 feature LuaJIT 2.1
 * backports — that is why they run on the host despite it being 5.1.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LuaFactory, type LuaEngine } from "wasmoon";
import { decodePluginMessage, type StateMessage } from "~/bolt-io/protocol";

const root = new URL("../../", import.meta.url);

/**
 * Files copied into the VM's virtual filesystem, at the same paths they occupy
 * in the repo, so `require("lua.detect.chat")` resolves exactly as it does in
 * game. Everything here is the real file; only the Bolt host and the two
 * vendored pixel-reading modules are faked, and those are faked in driver.lua.
 */
const SOURCES = [
  "main.lua",
  "lua/bridge.lua",
  "lua/json.lua",
  "lua/detect/chat.lua",
  "lua/detect/buffs.lua",
  "lua/detect/stats.lua",
  "lua/detect/probe.lua",
  "lua/detect/xp.lua",
  "tests/lua/driver.lua",
];

/** One WASM module for the whole run; a fresh engine per test keeps state clean. */
const factory = new LuaFactory();
let mounted: Promise<void> | null = null;

function mountAll(): Promise<void> {
  mounted ??= (async () => {
    for (const path of SOURCES) {
      const text = readFileSync(fileURLToPath(new URL(path, root)), "utf8");
      await factory.mountFile(`/${path}`, text);
    }
  })();
  return mounted;
}

/** An icon the game is about to draw. Buff detection keys off these. */
export type IconEvent = {
  kind: "icon";
  /** Model count and vertex count, which together ARE the buff's id. */
  models?: number;
  verts?: number;
  x?: number;
  y?: number;
  /**
   * Drawn size. Buff icons are all one size and inventory items another, which
   * is what lets detection stop carrying icons that could never be a buff.
   */
  w?: number;
  h?: number;
};

/** One image within a render2d batch. */
export type ImageSpec = {
  /** Position and size in the texture atlas. Chat anchors on an 11x11 entry. */
  ax?: number;
  ay?: number;
  aw?: number;
  ah?: number;
  /** Screen position of the top-left vertex. */
  x?: number;
  y?: number;
  /** The opposite corner, defaulting to top-left plus the atlas size. */
  x2?: number;
  y2?: number;
  /** Bytes returned by texturedata, for anything sampling more than one pixel. */
  texture?: string;
  /** The single colour this image's texture is filled with, as [r, g, b]. */
  rgb?: [number, number, number];
  /**
   * Vertex colour this image is tinted with on screen, as [r, g, b].
   *
   * Separate from `rgb` on purpose: the game draws all four resource bars from
   * one sprite and tints them apart, so what the texture contains and what
   * appears on screen are two different readings.
   */
  tint?: [number, number, number];
  /**
   * Draw this as an untextured colour fill rather than a sprite, in [r, g, b].
   *
   * A fill reports no texture coordinates — which is how Bolt distinguishes the
   * two — and has no atlas entry, so anything matching on atlas size cannot see
   * it at all.
   */
  flat?: [number, number, number];
  /** What the chat module should answer for the box anchored at this image. */
  chat?: { scrolled?: boolean; messages?: string[] };
  /**
   * The character this image draws, for the chat font lookup.
   *
   * The real module resolves this from pixels through a kilobytes-long table; a
   * fixture states it. See `chatBoxWithGlyphs`.
   */
  char?: string;
  /** Marks the '[' that opens a timestamp, which is what starts a new message. */
  tsstart?: boolean;
  /**
   * What the buff module should answer for the icon paired with this batch.
   *
   * `at` is the icon position this text belongs to. Set it and the fake rejects
   * any other icon, exactly as the real module does by checking where the buff
   * outline was drawn — which is what lets a test prove an icon was paired with
   * the right text rather than merely with some text.
   */
  buff?: {
    valid: boolean;
    number?: number | null;
    parens?: number | null;
    isbuff?: boolean;
    at?: [number, number];
  };
};

export type Render2dEvent = { kind: "render2d"; images: ImageSpec[] };

export type FrameEvent = IconEvent | Render2dEvent;

/** A state snapshot as it reaches the browser, after real JSON encoding. */
export type SentMessage = Record<string, unknown> & { t: string };

export type LuaPlugin = {
  /**
   * Render one frame, then swap buffers. `dtUs` advances the clock first and
   * defaults to one frame at 60fps, so the 600ms tick lands where it really
   * would rather than on every call.
   */
  frame(events?: FrameEvent[], dtUs?: number): void;
  /** Render `count` frames that draw nothing. */
  idle(count: number, dtUs?: number): void;
  /** Everything the plugin sent, exactly as it went over the wire. */
  sent(): SentMessage[];
  /**
   * State snapshots as the app receives them: put through the real schema, not
   * read raw. That closes the gap these tests exist to cover — Lua deletes table
   * keys assigned nil, so a field the schema requires can silently stop being
   * sent, and the failure surfaces in game as the plugin going quiet. Anything
   * the decoder rejects throws here instead.
   */
  states(): StateMessage[];
  /** The newest snapshot, decoded, or null before the first tick. */
  latest(): StateMessage | null;
  /** Deliver a message from the UI to the plugin, as raw JSON. */
  fromUi(json: string): void;
  /**
   * Run Lua against the loaded plugin. Escape hatch for odd cases.
   *
   * Not JavaScript eval: this compiles inside the wasmoon sandbox, which has no
   * JS realm, no host filesystem beyond the files mounted above, and no network.
   * Test-only, and every caller passes a literal written in this repo.
   */
  eval(source: string): unknown;
  /** Read a field off the driver table, e.g. "closed" or "flashes". */
  driver(field: string): unknown;
  /**
   * How many times the client swaps buffers per rendered frame. Bolt raises
   * onswapbuffers on every swap and the client makes as many as it likes, so
   * detection must not assume one. See driver.lua.
   */
  setSwapsPerFrame(n: number): void;
  close(): void;
};

/**
 * Boot main.lua against the fake host.
 *
 * The driver is required BEFORE main.lua, because it is what installs `bolt`
 * and the vendored modules into package.preload. Loading them the other way
 * round would send main.lua looking for a game client.
 */
export async function loadPlugin(): Promise<LuaPlugin> {
  await mountAll();
  const lua: LuaEngine = await factory.createEngine();

  lua.doStringSync(`package.path = "/?.lua"`);
  lua.doStringSync(`driver = require("tests.lua.driver")`);
  lua.doStringSync(`dofile("/main.lua")`);

  const call = (source: string): unknown => lua.doStringSync(source);

  const sent = (): SentMessage[] => JSON.parse(String(call(`return driver.dump()`))) as SentMessage[];

  /** Through the real decoder, the way the app sees it. */
  const states = (): StateMessage[] =>
    sent()
      .filter((m) => m.t === "state")
      .map((raw) => {
        const bytes = new TextEncoder().encode(JSON.stringify(raw));
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const decoded = decodePluginMessage(buffer as ArrayBuffer);
        if (decoded === null || decoded.t !== "state") {
          throw new Error(
            `the plugin sent a snapshot the app cannot decode, so it would read as no data at all:\n${JSON.stringify(raw)}`,
          );
        }
        return decoded;
      });

  return {
    frame(events = [], dtUs) {
      // Handed over as JSON rather than as a proxied JS object: the crossing is
      // then one string, and the spec arrives as a plain Lua table with no
      // wrapper semantics to reason about.
      const spec = JSON.stringify(events).replaceAll("]]", "] ]");
      call(`driver.frame(require("lua.json").decode([==[${spec}]==]), ${dtUs ?? "nil"})`);
    },
    idle(count, dtUs) {
      call(`driver.idle(${count}, ${dtUs ?? "nil"})`);
    },
    sent,
    states,
    latest: () => states()[states().length - 1] ?? null,
    fromUi(json) {
      call(`driver.fromui([==[${json}]==])`);
    },
    eval: call,
    driver: (field) => call(`return driver.${field}`),
    setSwapsPerFrame: (n) => void call(`driver.swapsperframe = ${n}`),
    close: () => lua.global.close(),
  };
}

/** Milliseconds of game time in one master tick, matching TICK_US in main.lua. */
export const TICK_US = 600_000;

/** An icon plus the render2d that carries its timer text — how a buff really arrives. */
export function buffDraw(
  models: number,
  verts: number,
  details: { number?: number | null; parens?: number | null; isbuff?: boolean } = {},
): FrameEvent[] {
  return [
    { kind: "icon", models, verts, x: 40, y: 60 },
    { kind: "render2d", images: [{ buff: { valid: true, ...details } }] },
  ];
}

/**
 * A buff whose icon is a plain sprite, laid out the way the game draws one:
 * icon, then its timer text, then the outline quads — all in ONE batch, with no
 * icon event anywhere.
 *
 * This is the case `onrendericon` structurally cannot see. Bolt raises that
 * event only for images it recognised as a rendered item model, so abilities,
 * prayers and familiars produce nothing at all, and half a measured bar was
 * unreachable because of it.
 *
 * The outline sits at the icon's exact top-left, which is both the equality the
 * vendored module validates on and the filter the sprite path keys off.
 */
export function spriteBuff(opts: {
  at: { x: number; y: number };
  texture: string;
  number?: number | null;
  parens?: number | null;
  isbuff?: boolean;
  size?: number;
  atlasX?: number;
}): Render2dEvent {
  const size = opts.size ?? 27;
  const isbuff = opts.isbuff !== false;
  const rgb: [number, number, number] = isbuff ? [90, 150, 25] : [204, 0, 0];
  // EACH SPRITE NEEDS ITS OWN ATLAS RECT, and defaulting it to the bar position
  // is what gives it one. Identity is cached by rect, so two fixtures sharing a
  // rect come back with one id however different their pixels are — which would
  // make an id test pass for the wrong reason and hide a hash that never looked
  // at the texture at all.
  const ax = opts.atlasX ?? opts.at.x;
  const { x, y } = opts.at;
  return {
    kind: "render2d",
    images: [
      { ax, ay: 0, aw: size, ah: size, x, y, texture: opts.texture },
      {
        buff: {
          valid: true,
          number: opts.number ?? null,
          parens: opts.parens ?? null,
          isbuff,
          at: [x, y],
        },
      },
      { flat: rgb, x, y, aw: size, ah: 1 },
      { flat: rgb, x, y: y + 1, aw: 1, ah: size - 2 },
      { flat: rgb, x, y: y + size - 1, aw: size, ah: 1 },
      { flat: rgb, x: x + size - 1, y: y + 1, aw: 1, ah: size - 2 },
    ],
  };
}

/**
 * The four action-bar resource levels and the colours that identify them.
 *
 * MEASURED FROM A LIVE CLIENT, NOT COPIED FROM THE DETECTOR. These are the
 * texture values the probe read out of the real draw stream on 2026-08-07, at
 * the pixel lua/detect/stats.lua samples:
 *
 *   bar 106x4 at 1488,1119  texture #f87650  tint #ffffff   (health)
 *   bar 106x4 at 1614,1119  texture #edcd1f  tint #ffffff   (adrenaline)
 *   bar 106x4 at 1740,1119  texture #8261b5  tint #ffffff   (prayer)
 *   bar 106x4 at 1866,1119  texture #1faca0  tint #ffffff   (summoning)
 *
 * THE PREVIOUS VALUES HERE WERE THE DETECTOR'S OWN CONSTANTS, WHICH MADE EVERY
 * TEST BELOW CIRCULAR. The harness drew a bar in exactly the colour stats.lua
 * was looking for, so the suite stayed green through an entire session in which
 * the real client identified none of the four — the tests could not fail for the
 * one reason the code could. A fake that restates the assumption under test
 * proves only that the assumption equals itself.
 *
 * Restating them from a reading is what makes "draw a red health bar" mean the
 * red the game actually draws. If these ever need changing, change them from a
 * new probe reading, never to whatever would make the detector pass.
 */
export const BAR_COLOURS = {
  hp: [0xf8, 0x76, 0x50],
  dren: [0xed, 0xcd, 0x1f],
  pray: [0x82, 0x61, 0xb5],
  sum: [0x1f, 0xac, 0xa0],
} as const satisfies Record<string, readonly [number, number, number]>;

/**
 * One action-bar resource bar, drawn `fill` full.
 *
 * The bar is a 106x4 atlas image stretched to its value, so the DRAWN width is
 * the reading: stats.lua measures from the far vertex back to the top-left one
 * and divides by 89. Each bar gets its own atlas row so a pixel probe into one
 * cannot land in another.
 */
export function bar(key: keyof typeof BAR_COLOURS, fill: number, row = 0): ImageSpec {
  const left = 10;
  return {
    ax: 0,
    ay: row * 4,
    aw: 106,
    ah: 4,
    x: left,
    y: 500,
    x2: left + 1 + fill * 89,
    rgb: [...BAR_COLOURS[key]],
  };
}

/**
 * A chat box drawn glyph by glyph, so the colour pass has something to read.
 *
 * `chatBox` below states what the module WOULD assemble and draws no text at all,
 * which is right for testing everything downstream of the read. Colours are not
 * downstream of it: `lua/detect/chat.lua` reads them off the glyph vertices
 * itself, so proving that works needs real glyphs.
 *
 * Each character is drawn TWICE — black drop-shadow, then the same glyph in the
 * intended colour, one pixel along — because that is how the game draws font and
 * how the vendored module finds a colour at all (`i + verticesperimage`). Each
 * distinct character gets its own atlas entry, since `lookupchatcharacter` is
 * handed atlas coordinates rather than an index.
 *
 * Messages are emitted newest-first, the order the engine renders them in.
 */
export function chatBoxWithGlyphs(
  at: { x: number; y: number },
  messages: Array<{ text: string; colour: [number, number, number] }>,
): { event: Render2dEvent; timestamped: string[] } {
  const images: ImageSpec[] = [];
  // SPACES HAVE NO GLYPH, so they produce no vertex and are simply absent from
  // what the module assembles. Stripping them here keeps the fixture's stated
  // text and its drawn glyphs in agreement — and they have to agree exactly,
  // because that text match is what attaches a colour to a message.
  const timestamped = messages.map((m, n) => `[00:00:0${n}]${m.text.replaceAll(" ", "")}`);

  // One atlas slot per distinct character, so a glyph is identifiable the way the
  // real font table identifies it.
  const atlas = new Map<string, { ax: number; ay: number }>();
  const slotFor = (ch: string): { ax: number; ay: number } => {
    let slot = atlas.get(ch);
    if (slot === undefined) {
      slot = { ax: 400 + atlas.size * 8, ay: 200 };
      atlas.set(ch, slot);
    }
    return slot;
  };

  // Newest first, matching the engine. Each message occupies its own row.
  const newestFirst = timestamped
    .map((full, n) => ({ full, colour: messages[n]!.colour }))
    .reverse();

  newestFirst.forEach(({ full, colour }, row) => {
    const y = at.y + 20 + row * 14;

    [...full].forEach((ch, col) => {
      const { ax, ay } = slotFor(ch);
      const x = at.x + col * 7;
      const timestampChar = col < 10;
      // The timestamp is white brackets and timestamp blue; the body carries the
      // colour under test. Only the opening '[' is a timestamp START.
      const drawn: [number, number, number] = timestampChar ? [255, 255, 255] : colour;

      images.push({
        ax, ay, aw: 6, ah: 9, x, y, char: ch,
        tsstart: col === 0,
        tint: [0, 0, 0],
      });
      images.push({ ax, ay, aw: 6, ah: 9, x: x + 1, y, char: ch, tint: drawn });
    });
  });

  return {
    event: {
      kind: "render2d",
      images: [{ aw: 11, ah: 11, x: at.x, y: at.y, chat: { messages: timestamped } }, ...images],
    },
    timestamped,
  };
}

/**
 * A run of text drawn in the game font, glyph by glyph.
 *
 * XP drops are read as text, so a fixture has to draw text. Each character is
 * drawn twice — shadow then colour, a pixel apart, the same pairing the font
 * always uses — and every distinct character gets its own atlas entry, because
 * the lookup is handed atlas coordinates rather than an index.
 *
 * `gap` is the advance between characters. The detector merges glyphs into one
 * run while they stay on a row and within MAX_GLYPH_GAP of each other, so a
 * fixture can split one apart by widening this.
 */
/**
 * Atlas height of each glyph at one font size, read out of the vendored tables.
 *
 * NOT ALL THE SAME, AND THAT IS THE WHOLE POINT. `chatchars` is keyed by a
 * glyph's own bounding-box height rather than by font size: digits and capitals
 * live at {8,9,10,12,13,14,16}, '+' at {6,7,9,10,11,12}, ',' at {3,4,5} and '.'
 * at {2,3}. So within ONE line at ONE size the quads have different heights, and
 * on a shared baseline their TOP edges are several pixels apart.
 *
 * Drawing every glyph at one height — which this helper used to do — makes any
 * reader that groups a run by its top edge look correct. It is not: a comma's top
 * sits ~4px below a digit's, so "+1,234" breaks at the comma and reads as 1.
 */
const GLYPH_HEIGHT: Record<string, number> = {
  ",": 4,
  ".": 3,
  "+": 6,
  "/": 13,
};

function glyphHeight(ch: string): number {
  // Digits, letters and everything else this helper is asked to draw sit at 8.
  return GLYPH_HEIGHT[ch] ?? 8;
}

export function fontRun(
  text: string,
  at: { x: number; y: number },
  gap = 7,
  atlasBase = 700,
): ImageSpec[] {
  const images: ImageSpec[] = [];
  const atlas = new Map<string, number>();

  [...text].forEach((ch, col) => {
    let ax = atlas.get(ch);
    if (ax === undefined) {
      ax = atlasBase + atlas.size * 8;
      atlas.set(ch, ax);
    }
    const ah = glyphHeight(ch);
    const x = at.x + col * gap;
    // `at.y` is the BASELINE. A short glyph is drawn lower so its bottom lands on
    // it, which is how the game lays text out and what makes the top edges differ.
    const y = at.y - ah;
    images.push({ ax, ay: 300, aw: 6, ah, x, y, char: ch, tint: [0, 0, 0] });
    images.push({ ax, ay: 300, aw: 6, ah, x: x + 1, y, char: ch, tint: [255, 255, 255] });
  });

  return images;
}

/** A chat box: an 11x11 speech-bubble anchor plus whatever it is showing. */
export function chatBox(
  at: { x: number; y: number },
  chat: { scrolled?: boolean; messages?: string[] },
): Render2dEvent {
  return {
    kind: "render2d",
    images: [
      { aw: 11, ah: 11, x: at.x, y: at.y, chat },
      { aw: 0, ah: 0, x: at.x, y: at.y + 12 },
    ],
  };
}
