# AFK Goblin on Bolt — migration design

**Date:** 2026-08-06
**Status:** approved design, not yet planned
**Supersedes:** nothing. Extends [`2026-08-05-afkuav-design.md`](2026-08-05-afkuav-design.md), which remains the authority on alerter semantics and the AfkWarden defect analysis.

## Decision

Migrate AFK Goblin from the Alt1 Toolkit to the [Bolt Launcher](https://bolt.adamcake.com/) plugin
ecosystem, as a **new plugin** rather than a fork of
[bolt-alerts](https://codeberg.org/Adamcake/bolt-alerts). Retire the Alt1 build once parity is
reached.

Architecture is **thin Lua, thick browser**: Lua does detection only and pushes state snapshots;
the existing TypeScript engine, alerters, store, importer and UI evaluate rules unchanged in an
embedded browser.

## Why Bolt

Alt1 screenshots the window and pattern-matches pixels. Bolt injects into the RS3 process and hooks
the graphics calls, so a plugin reads the game's **draw calls** — pre-composite, taken from the CPU
before upload to the GPU. `texturecompare` is documented as a literal `memcmp`, with the note that
this means "there will never be any imprecision issues caused by different GPUs/drivers".

Four structural defect classes stop being expressible:

1. **Reader position drift.** There are no reader positions. Nothing is located by searching a
   screenshot, so nothing can be invalidated by a resize or UI-scale change. The entire
   self-healing-anchor apparatus (`src/readers/anchor.ts`, `anchored-reader.ts`) becomes unnecessary
   rather than merely correct.
2. **Buff template erosion.** There are no templates. `bolt-buffmodule` identifies glyphs by exact
   byte-match against the game's own font atlas, per font size. No 50-pixel floor, no re-masking
   ratchet, no sparse-template disadvantage.
3. **Occlusion blindness.** `alt1.mousePosition` reports hovers for the client *rectangle*
   regardless of z-order, which is why `src/alt1-io/activity.ts` uses "is the chatbox still
   findable?" as a proxy for "is the game actually visible?". Bolt hooks the game's real
   `WNDPROC`/XCB event stream: if the event arrived, the game received it. That file is deleted, not
   ported.
4. **Capture cost and availability.** No screen capture at all, so no per-tick capture budget and no
   dependence on the game being unobscured or focused.

Bolt also offers capabilities Alt1 structurally cannot: `bolt.playerposition()` in world
coordinates, and identification of rendered 3D models — which is what makes in-game highlighting of
enriched springs possible at all.

### Why not fork bolt-alerts

- **Licence.** bolt-alerts is GPL2. Forking pulls the UI into GPL2. The two modules actually worth
  having — [`bolt-chatmodule`](https://codeberg.org/adamcake/bolt-chatmodule) and
  [`bolt-buffmodule`](https://codeberg.org/adamcake/bolt-buffmodule) — are UNLICENSE (public domain)
  and consumable independently as submodules. They are also the genuinely hard parts: 1,435 and 234
  lines of hand-derived font atlas tables.
- **Declared divergence.** Its README states it is "NOT an 'AFK Warden'… this plugin is simpler and
  smaller in scope than that. If you want to do those things, make your own plugin." A fork would
  never converge back upstream.

bolt-alerts remains valuable as a **reference implementation** — its stat-bar reading, XP-drop glyph
detection, crafting-progress logic and model-highlight drawing are all patterns to follow.

## Parity analysis

Measured against the reference config (`afkscape_presets.json`, 15 presets, 108 alerts):

| Type | Count | Bolt path | Work required |
| --- | ---: | --- | --- |
| `chat` | 74 | `bolt-chatmodule` | none — wrap the module |
| `inactive` | 13 | `onmousebutton` / `onmousemotion` / `onscroll` | none — strictly better than today |
| `actionbar` | 8 | stat bars (HP/prayer thresholds) | port bolt-alerts' approach |
| `buffs` | 7 | `bolt-buffmodule` | 1 new buff + config migration for 6 |
| `xpcounter` | 4 | **new** — per-skill XP drop reading | new detection module |
| `craftmenu` | 1 | crafting-progress bar | port bolt-alerts' approach |
| `sheathe` | 1 | custom | unbuilt on Alt1 today either |

**95 of 108** (chat + inactive + actionbar) land on detection that already exists and is proven in
the wild.

Notes on the remainder:

- **`buffs`.** Five of six distinct buffs used — Overload, Perfect Plus, Aura, Familiar/summon,
  Spirit attraction — are already in bolt-alerts' known-buffs table. Only **Juju Mining Pot** needs
  fingerprinting. Separately, all six need a config migration (below).
- **`xpcounter`.** These alerts name a skill (`fle`, `tot`, `div`) and an XP threshold over a delay.
  bolt-alerts detects only *that* an XP drop occurred, via the `+` glyph in `onrender2d`; it reads
  neither skill nor amount. Reading both is tractable with the same techniques — the skill icon is
  identifiable in the texture atlas and the digits are readable via the buffmodule's glyph-lookup
  approach — but it is genuinely new work and the largest new detection piece in this migration.
- **`sheathe`** stays unimplemented, as it is today. One alert.

### What this costs in code

| Area | LOC | Fate |
| --- | ---: | --- |
| `src/alt1-io`, `src/readers` | 1,484 | **deleted** — no Bolt equivalent needed |
| `src/engine`, `src/alerters` | 1,342 | **retained**, with the reader seam swapped for pushed state |
| `src/ui`, `src/store`, `src/import` | ~2,900 | **retained** essentially unchanged |
| new Lua | ~600 est. | detection + bridge + model table |

## Architecture

```
┌──────────────── game process ────────────────┐
│                                              │
│  Bolt injected library (C)                   │
│    hooks OpenGL + WNDPROC/XCB                │
│         │                                    │
│    ┌────▼──────────────┐                     │
│    │  main.lua         │  detection only     │
│    │  + lua/detect/*   │  no rule logic      │
│    │  + modules/{chat,buffs}  (submodules)   │
│    └────┬──────────────┘                     │
│         │ sendmessage / onmessage (JSON)     │
│    ┌────▼──────────────────────────────────┐ │
│    │  embedded CEF browser                 │ │
│    │  plugin://app/index.html         │ │
│    │                                       │ │
│    │  src/engine   — TickLoop, registry    │ │
│    │  src/alerters — all 16 types          │ │
│    │  src/store    — zod schemas           │ │
│    │  src/import   — AfkWarden importer    │ │
│    │  src/ui       — Preact + CSS          │ │
│    │  src/alerting — sound, TTS, taskbar   │ │
│    └───────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

Rationale for the split: the Lua side is the part that **cannot be unit-tested**, so it should
contain the least logic. Detection is mechanical and stateless-ish; rule evaluation is where the
subtlety lives and where the existing vitest suite already pays for itself.

The IPC-volume objection does not hold. Render events fire per frame, but Lua emits only on
*change*, coalesced to the master tick. Buff timers tick once a second, chat lines are occasional,
stat fractions change rarely. Worst case is a few dozen small messages per second through a bridge
built for exactly this.

### Bridge protocol

`browser:sendmessage(str)` arrives in JS as a `message` event with
`{type: "pluginMessage", content: ArrayBuffer}`, byte-for-byte. Messages are newline-free JSON, one
object per call. Lua has no built-in JSON, so vendor [`json.lua`](https://github.com/rxi/json.lua)
(rxi, MIT, ~390 lines) rather than hand-rolling encoding.

**Lua → browser**

```jsonc
// every master tick (600ms), as a FULL snapshot — not a delta
{ "t": "state", "tick": 1234,
  "clickIdleMs": 4200,          // since last mouse button
  "mouseIdleMs": 900,           // since last motion/scroll
  "focused": true,
  "loggedIn": true,
  "stats":  { "hp": 0.28, "pray": 0.91, "sum": 1.0, "dren": 0.4 },  // 0..1, null if unreadable
  "buffs":  [ { "id": "overload", "timeLeft": 27, "stacks": 1 } ],
  "debuffs": [],
  "player": { "x": 3221, "y": 3218, "z": 0 },
  "models": [ "enrichedspring" ],   // identified on screen this tick
  "craftProgress": 0.62 }           // null when no crafting menu

{ "t": "chat",  "lines": [ { "text": "…", "colors": [[255,255,255]], "fragments": ["…"] } ] }
{ "t": "xp",    "skill": "div", "amount": 1200 }
{ "t": "hello", "apiVersion": [1,0], "character": "…" }
{ "t": "config","data": "…" }     // the stored blob, handed over once at startup
```

Full snapshots, not deltas: at this size the saving is negligible and merge semantics would be a
whole class of bug. It also lets "unreadable" be an explicit `null` rather than an absence, which is
what `TriggerState.functional` needs to distinguish "not triggered" from "cannot see".

**No clock crosses the bridge.** `bolt.time()` is monotonic *microseconds* from an arbitrary origin
and wraps roughly hourly on a 32-bit CPU, so it is not a wall clock. Lua sends only durations, in
milliseconds; the browser stamps its own `Date.now()`. This is the same trap as `rsLastActive` — a
number that reads like a timestamp and is not one — and it is kept out by the shape of the protocol
rather than by comment.

**Absent means null.** Assigning `nil` to a Lua table field deletes the key, so anything Lua reports
as unreadable arrives *absent*, never as an explicit null. The nullable fields (`stats`, `player`,
`craftProgress`, `character`) therefore default to null in the schema. The required scalars
deliberately do not: a missing `clickIdleMs` is a plugin bug and must fail loudly rather than decode
as a plausible zero.

**Browser → Lua**, by POST to `https://bolt-api/send-message` (body byte-for-byte):

```jsonc
{ "t": "highlight", "models": ["enrichedspring"] }  // which models to draw boxes around
{ "t": "flash" }                                    // bolt.flashwindow
{ "t": "save", "data": "…" }                        // bolt.saveconfig
```

Closing is *not* a message. CEF disables `window.close()`, so the page self-closes by requesting
`https://bolt-api/close-request`, which fires `oncloserequest` in Lua.

Config persistence stays on the Lua side via `bolt.loadconfig`/`bolt.saveconfig`, keyed by
`bolt.characterid()` with a shared-default fallback — the pattern bolt-alerts uses. This replaces
`localStorage`, which is not durable across plugin reinstalls. Lua stores the blob verbatim and
never parses it, so the schema stays in one place.

### Changes to the TypeScript seam

`AlerterContext` is already almost the right shape. The change is to make it fully pure data, which
its own doc comment aspires to:

```ts
export interface AlerterContext {
  tick: number;
  now: number;
  idleMs: number;        // since last click — unchanged semantics, now event-derived
  mouseIdleMs: number;   // since last motion — unchanged semantics, now event-derived
  connected: boolean;    // replaces hasGameState: is the Lua side alive and in-game
  chatLines: readonly ChatLine[];
  chatAvailable: boolean;
  state: GameState;      // replaces `readers: ReaderAccess` and `geometry`
}
```

`GameState` is the pushed snapshot — the same information `ReaderAccess` exposed, as fields rather
than memoized pull methods. The per-tick memoization exists to avoid redundant OCR; with no OCR
there is nothing to memoize.

`TickLoop` loses `geometry`, `capture` and `chat` (the ChatboxPool) from `LoopDeps`, and gains a
single "latest snapshot" reference. It keeps `TICK_MS = 600` and the `ticks` divisor semantics so
per-alerter cadence is unchanged.

Alerter call sites change mechanically: `ctx.readers.actionbar()` → `ctx.state.stats`,
`ctx.readers.buffs()` → `ctx.state.buffs`, and so on. The `functional` flag in `TriggerState` keeps
its meaning — it now reports "Lua could not read this" instead of "the reader is lost".

### Config migration: buff identity

This is the one place stored user data does not carry over cleanly.

On Alt1 a buff alert stores `bufftype.imgstr` — a base64 PNG of the buff icon captured from the
screen — and matches it as a needle. Bolt identifies buffs by name against the texture atlas, so
`BuffSlot` changes from `{ icon: Needle; timeLeft }` to `{ id: string; timeLeft; stacks }`.

Migration path, in the existing importer:

1. Ship a lookup table mapping known AfkWarden needle hashes → Bolt buff ids, seeded with the six
   buffs in the reference config.
2. On import, resolve what it can automatically.
3. For anything unresolved, keep the alert and flag it — the same "keep and badge, never silently
   drop" behaviour the importer already has for unimplemented types — and let the user pick the buff
   from a searchable list in the editor.

Six entries is small enough to seed by hand, and the fallback means an unknown buff degrades to one
dropdown selection rather than a lost alert.

## Enriched spring highlighting

The mechanism already exists in bolt-alerts (`main.lua:1165`): hook `onrender3d`, look up
`render3dlookup[event:vertexcount()]`, and call `drawbox`. Identification is cheap because
`vertexpoint` returns static model data that "will always be the same for two instances of the same
model":

```lua
[672] = function (event)
  local x, y, z = event:vertexpoint(1):get()
  if x == 0 and y == 401 and z == 0 then return models.firespirit end
end,
```

Springs are not in its table (the nearest entries are `manifestedknowledge`, `corememoryfragment`
and `divinecarpetdust`). Discovering the signature needs a live instrumentation session:

1. Add a dev-only mode to the Lua plugin that logs, per distinct signature seen, the
   `vertexcount`, `vertexpoint(1)` and `animated()` of every render event — and does so across
   **`onrender3d`, `onrenderbillboard` and `onrenderparticles`**. Divination wisps are heavily
   particle-based, so the spring may not be a plain 3D model. bolt-alerts already tracks billboards
   separately for exactly this reason (`runespherecore` is a billboard, `runesphere` is not).
2. Stand at a colony and record two logs: one with an enriched spring present, one without.
3. Diff for the signature that appears only in the first.
4. Add it to `lua/detect/models.lua` and tune `center` / `boxsize` / `boxthickness` against the
   drawn box. `printmodelbounds` (bolt-alerts `main.lua:498`) exists for this.

**Fragility to accept:** a graphical update that changes the model changes its vertex count, and the
highlight silently stops. Mitigations: verify against more than one vertex so a coincidental
vertex-count collision cannot false-positive, and fail soft — an unrecognised model draws nothing,
never errors. Plugin code runs inside the game process, so an uncaught Lua error can take RS3 down
with it; every detection path must be defensive.

Note also that bolt-alerts deliberately suppresses highlighting for 2 minutes in every 10
(`if (bolt.time() % 600000) <= 480000`). Whether to reproduce that is a policy decision, not a
technical one.

## Testing

The naive read is that this is a regression: `alt1/base` exports `PasteInput`, so reader logic can
be developed today by pasting screenshots into an ordinary browser, and there is no equivalent for
render events.

The bridge makes a better answer available. Because everything crossing into the engine is JSON,
sessions can be **recorded and replayed**:

- **Record.** A dev flag makes the Lua side append every outgoing message to a file. One real
  session at a divination colony, one at a boss, one AFK in the lobby.
- **Replay.** A vitest fixture feeds a recorded stream through `TickLoop` and asserts which alerters
  fire and when.

This covers strictly more than `PasteInput` did — whole timelines rather than single frames, and it
exercises the engine, alerters, gating and cadence together. Existing tests for
`engine/`, `alerters/`, `store/`, `import/` and `ui/` survive largely as-is;
`tests/readers/*` and `tests/alt1-io/*` are deleted with the code they cover.

What remains genuinely untestable offline is the Lua detection layer itself — glyph lookups, model
fingerprints, stat-bar geometry. That is the explicit reason for keeping it thin.

## Distribution

Bolt installs a plugin from a `meta.json` URL carrying a version, a tarball URL and a sha256. The
already-installed Ground Markers plugin serves its from
`j3sven.github.io/bolt-groundmarkers/dist/meta.json`, so GitHub Pages is a proven host.

The archive format is **`.tar.zst`**, with `bolt.json` at the archive root — the format bolt-alerts
and Ground Markers both ship. The existing `.github/workflows/ci.yml` extends rather than gets
replaced: after `npm run build`, assemble the plugin directory (`bolt.json`, `main.lua`, `lua/`,
`modules/`, and the built app at `app/`), tar it with zstd, compute the sha256, emit `meta.json`,
and publish the tarball and `meta.json` to Pages. `npm run typecheck && npm test` stay as they are.

CI also runs `luac -p` over every `.lua` file. The Lua layer cannot be unit-tested, so a syntax
check is the only automated guarantee available on it; without one a typo ships and surfaces as a
dead plugin in-game.

`bolt.json` is the plugin manifest (`main`, `name`, `version`, `description`). Installation is then
by pasting the `meta.json` URL into Bolt's plugin manager — replacing the current "open the URL
inside the Alt1 browser and press Add App" flow.

## Repo layout

```
AFK Goblin/
  bolt.json                 # plugin manifest
  main.lua                  # entry: wiring only
  lua/                      # required as "lua.bridge" etc — Bolt resolves dot paths from the root
    bridge.lua              # JSON framing, message dispatch, config persistence
    json.lua                # vendored rxi/json.lua (MIT)
    detect/
      chat.lua              # wraps modules/chat
      buffs.lua             # wraps modules/buffs + identity table
      stats.lua             # hp / prayer / summoning / adrenaline bars
      xp.lua                # per-skill XP drop reading (new)
      activity.lua          # mouse idle timers
      craft.lua             # crafting progress bar
      models.lua            # model fingerprints + highlight drawing
  modules/
    chat/                   # submodule → bolt-chatmodule  (UNLICENSE)
    buffs/                  # submodule → bolt-buffmodule  (UNLICENSE)
  src/                      # existing Preact app
    bolt-io/                # NEW — replaces alt1-io; bridge client, snapshot store
    engine/ alerters/ store/ import/ ui/ alerting/
  tests/
    fixtures/sessions/      # NEW — recorded bridge streams
```

`src/` keeps its name and its Vite build; only the output location and the `alt1-io` → `bolt-io`
seam change.

## Build order

Staged so that something works end to end early, and the riskiest unknown is not last.

1. **Bridge skeleton.** `bolt.json`, `main.lua`, `lua/bridge.lua`, `src/bolt-io/`. Lua sends a
   `hello` and a heartbeat; the browser renders the existing UI shell inside Bolt. Proves the
   embedded-browser path, config persistence and the build/packaging pipeline before any detection
   exists.
2. **Engine seam swap.** `AlerterContext` → pushed `GameState`; `TickLoop` deps shrink; delete
   `alt1-io` and `readers` plus their tests. The suite must be green against fixture snapshots.
3. **Inactivity + chat.** Wire `modules/chat` and the mouse timers. That is 87 of 108 alerts live.
4. **Stats.** HP/prayer bars → the 8 `actionbar` alerts.
5. **Buffs.** Wire `modules/buffs`, seed the identity table, add Juju Mining Pot, ship the importer
   migration. 7 alerts.
6. **Model highlighting.** Instrumentation mode, the colony session, enriched springs. This is the
   feature that motivated the migration and it is deliberately after parity, because it is the only
   step whose duration cannot be estimated in advance.
7. **XP per-skill.** The new detection module. 4 alerts.
8. **Session recording/replay harness.** Can slot in any time after step 2; earlier is better.
9. **Retire Alt1.** Only once 1–7 are done.

`craftmenu` (1 alert) and `sheathe` (1 alert) are explicitly out of scope for parity — `craftmenu`
is a cheap follow-up once the render2d plumbing exists; `sheathe` is unbuilt today.

This is more work than one implementation plan should carry. It splits at the natural seams:

- **Plan 1 — foundation** (steps 1–2, plus 8). Bridge, packaging, engine seam swap, replay harness.
  Ends with a green suite and a plugin that installs and renders but detects nothing. Everything
  after this is additive.
- **Plan 2 — parity** (steps 3–5, 7). The alerter types, in descending order of how many alerts they
  unblock. Ends at 106 of 108.
- **Plan 3 — highlighting** (step 6). Instrumentation, the colony session, enriched springs. Kept
  separate because it is the only step gated on live discovery rather than on code.

Step 9 (retire Alt1) is a decision, not a plan.

## Risks and open questions

- **Terms of service.** Alt1 reads the screen from outside the process; Bolt manual-map-injects and
  hooks the import table. Bolt's docs argue it "does fall within the terms of service" but state
  plainly that "Bolt hasn't been officially approved, so you choose to use it at your own risk" and
  that it is not undetectable. RS3 has no approved-client list. This is a real and unresolved
  difference in risk posture, accepted knowingly: Bolt is already installed with three plugins on
  autostart.
- **Keyboard activity is invisible, and that is accepted.** Bolt exposes no key events. Activity is
  therefore mouse-derived: clicks, motion and scroll. This is *not* a regression against Alt1, whose
  `rsLastActive` is click-based with optional polled mouse movement and carries no keyboard signal
  either — so inactivity behaviour matches or beats the current build. Adding key events would mean
  patching and self-building Bolt; **out of scope, by decision, and not to be reopened as part of
  this migration.**
- **`bolt.isfocused()` is always false on Windows.** Confirmed in-game, and confirmed against Bolt's
  source: Linux tracks focus from `XCB_FOCUS_IN`/`FOCUS_OUT` events into a guarded flag
  (`so/main.c:355`), but Windows is `return GetFocus() == game_hwnd` (`dll/main.c:197`). `GetFocus()`
  only reports a focus window belonging to the *calling thread's* message queue, and Lua runs on the
  render thread, so it returns NULL. The correct call is `GetForegroundWindow()`.

  Blast radius is small and fails safe: `focused` feeds only `shouldSuppress`, which early-returns
  unless `activeSuppress` is on — and that defaults to off. Stuck-false means alerts are never
  suppressed, i.e. extra alerts rather than missed ones. Taskbar flashing is unaffected, because
  `_bolt_flash_window` uses `FlashWindowEx` with `FLASHW_TIMERNOFG` and never consults the broken
  check.

  **Do not build anything that fails dangerously when this is wrong.** Worth reporting upstream; it
  is a one-line fix, and fixing it there is preferable to working around it here.
- **Model fragility.** Graphical updates break vertex-count fingerprints. Fail soft, verify against
  multiple vertices.
- **In-process crashes.** A Lua error can take the game down. Defensive detection code; keep logic
  out of Lua.
- **Upstream module drift.** `bolt-chatmodule` and `bolt-buffmodule` are pinned submodules
  maintained by a third party against a moving game. Pin deliberately and update on purpose.

## Licence

Currently undecided, which was tenable while every dependency was permissive. Still tenable: both
Bolt modules are UNLICENSE, `json.lua` is MIT, and bolt-alerts (GPL2) is a reference, not a
dependency. **Copying code from bolt-alerts would change this** — patterns and techniques may be
reimplemented freely, but its source must not be pasted in.
