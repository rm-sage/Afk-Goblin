# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
git submodule update --init --recursive   # modules/chat and modules/buffs are vendored submodules

npm run build       # vite build -> app/  (this IS the plugin's UI directory)
npm run typecheck   # tsc --noEmit
npm test            # vitest run  (includes the Lua suite)
npm run test:watch
npm run ci          # typecheck + test + build, same order as .github/workflows/ci.yml
npm run dev         # plain-browser vite server; no plugin attached, so everything reads "no data"

npx vitest run tests/lua/chat.test.ts          # one file
npx vitest run tests/lua -t "scrolled"         # one test by name
luac5.4 -p main.lua                            # CI syntax-checks every .lua file this way
```

## The dev loop, and the one thing that isn't hot

The repo root **is** the Bolt plugin directory — `bolt.json`, `main.lua`, `lua/`, and the built
`app/` all sit here, so there is no packaging step. Bolt is pointed at `bolt.json` once.

- Changed something under `src/` → `npm run build`, reload the UI window.
- Changed `main.lua` or anything under `lua/` → **restart the plugin in Bolt.** The Lua layer is
  loaded once at plugin start; a rebuild does nothing for it.

## Architecture: thin Lua, thick browser

Detection runs as Lua inside the game process and pushes state snapshots over a JSON bridge; rule
evaluation, storage and the entire UI run in the browser. The Lua side deliberately holds the least
logic possible, because an uncaught Lua error stops the plugin and can take the client with it.

```
lua/detect/*.lua  ──┐
main.lua (tick)  ───┼─> lua/bridge.lua ─JSON─> bolt-io/protocol.ts (zod)
                    │                              │
                    │                          bolt-io/snapshot.ts   (levels vs. events)
                    │                          bolt-io/game-state.ts (accumulates XP etc.)
                    │                              │
                    │                          engine/loop.ts (TickLoop, 600ms)
                    │                              │
                    │                          alerters/*  ──> alerting/* (alarm, sound, speech)
                    └─ inbound: save / flash / probe  <──  ui/App.tsx (Preact)
```

- `src/main.tsx` is the composition root: it owns presets, settings, the tick interval, and repaints
  every tick (props are the only way plugin data reaches the UI).
- `~/` is a path alias for `src/` (`vite.config.ts` and `tsconfig.json` both declare it).

### Wire-protocol invariants

These are the traps this design exists to prevent; violating one produces a silent failure, not an
error.

- **Only durations cross the bridge, never timestamps.** `bolt.time()` is monotonic *microseconds*
  from an arbitrary origin and wraps roughly hourly on 32-bit. The browser stamps its own
  `Date.now()`. `idleMs` is milliseconds *since* the last click — a duration — and is named that way
  because AfkWarden's identically-shaped `rsLastActive` reads like a timestamp and is not one.
- **Lua deletes table keys assigned `nil`,** so optional fields arrive at the schema *absent*, never
  as an explicit null. Optional fields must be `.nullable().default(null)`; `.nullable()` alone
  rejects the message, and one rejected buff fails the whole snapshot.
- New protocol fields should be defaulted, so an older plugin against a newer UI degrades to zeroes
  rather than failing to decode.
- `TICK_MS` in `src/engine/loop.ts` and `TICK_US` in `main.lua` are the same tick and must stay in
  step.

### Honest failure, everywhere

`null` means "could not be read" and is distinct from zero or empty. `TriggerState.functional`
carries that up to the UI as a **no data** badge. Alerts whose type has no runtime, or whose
detection isn't written yet (`AWAITING_DETECTION` in `src/engine/registry.ts`), are kept and flagged
rather than dropped — an imported preset must never silently lose an alert. Same principle in
`SnapshotStore.connected`: a snapshot older than `STALE_AFTER_MS` stops being believed.

### Adding an alerter type

Write a module in `src/alerters/` via `defineAlerter` (zod schema for its vars, a `FieldSpec[]` for
the editor, `create()` returning a `check(ctx)`), then register it in `src/engine/registry.ts`.
Alerters receive plain data and never touch a reader, screen or clock, so they test as pure
functions. If the type exists in AfkWarden but detection isn't ready, leave it in
`AWAITING_DETECTION` rather than unregistered.

## Bolt platform constraints

Discovered the hard way; don't re-derive them.

- **No keyboard.** Bolt's input layer is mouse-only, so activity is derived from clicks, motion and
  scroll. The UI uses an **external** browser window (`bolt.createbrowser`) precisely because
  embedded browsers are offscreen-rendered and can't receive typing.
- `bolt.isfocused()` is always false on Windows (Bolt calls `GetFocus()` from the render thread).
  It's sent anyway so the browser can see what it's told; suppression keys off click idleness.
- `onswapbuffers` is **not** a frame boundary — the client may swap several times per frame. It only
  decides when a tick has elapsed; detectors scan every frame and publish on the tick.
- Scanning is bounded by *time* (`SCAN_BUDGET_US`), not by frames, because walking every image of
  every render2d batch costs real FPS. Ordering in the tick callback matters: each detector's
  `request()` publishes-then-resets, so reads must follow it.
- CEF disables `window.close()`; the UI self-closes via the `/close-request` endpoint.
- `bolt.characterid()` is an opaque private hash that also names the config file — never send it
  over the bridge or show it. Use `charactername()` for display.

## Testing

- `tests/lua/` boots the real `main.lua` and `lua/**` in a Lua 5.4 VM (wasmoon) against a fake Bolt
  host (`tests/lua/driver.lua`), renders frames, advances ticks, and asserts on the JSON decoded
  through the real zod schema. **A new file under `lua/` must be added to `SOURCES` in
  `tests/lua/harness.ts`** or it won't be mounted. This suite exists because the bugs that actually
  shipped were in the wiring *between* Lua modules, and each cost a live play session to find.
- `tests/support/replay.ts` replays a recorded bridge session through the real engine on a virtual
  clock — the successor to Alt1's single-frame paste workflow, since most alerting bugs are about
  timing and staleness. Record one from the probe page's **Copy session JSON**.
- `app/probe.html` (`src/probe.tsx`) is the live-host diagnostic: handshake, tick rate, both message
  directions, config round-trip. Use it for questions a fake host cannot answer.
- `fixtures/personal/` holds a real AfkWarden config and is **gitignored on purpose** (public repo).
  Tests that need it skip when it's absent.

## Vendored submodules

`modules/chat` and `modules/buffs` are UNLICENSE modules from Adamcake (bolt-chatmodule,
bolt-buffmodule) — hand-derived font-atlas tables. Treat as read-only; `lua/detect/*` wraps them and
restates any constant it depends on with a file:line reference.

## Reference

`docs/superpowers/specs/2026-08-05-afkuav-design.md` is the authority on alerter semantics and the
AfkWarden defect analysis; `docs/superpowers/specs/2026-08-06-bolt-migration-design.md` covers the
Bolt architecture and what was deliberately dropped. Read those before re-deriving a decision.

Release: CI tars the plugin layout and publishes `meta.json` to GitHub Pages, with the download URL
built from the repo name and the version read from `bolt.json` — both need updating together on a
rename or version bump.
