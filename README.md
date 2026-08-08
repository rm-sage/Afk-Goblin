# AFK Goblin

A modern replacement for the RuneScape 3 [Alt1 Toolkit](https://runeapps.org/alt1) plugin
**AfkWarden** — full feature parity, rebuilt UI, multi-chatbox monitoring, and fixes for two
reliability defects that make the original intermittently unusable.

> **Status:** usable. Installs, imports AfkWarden presets, and 10 of the 16 alerter types are live —
> covering 106 of the 108 alerts in the reference config. Full preset and alert editing, sound,
> text-to-speech, local custom sounds, drag-to-reorder and the taskbar countdown all work. Importing
> a preset that uses one of the remaining 6 types keeps the alert and flags it rather than dropping
> it silently.

## Install

A [Bolt Launcher](https://bolt.adamcake.com/) plugin. Enable the plugin loader in Bolt's settings,
then add from this URL:

```
https://rm-sage.github.io/Afk-Goblin/meta.json
```

Then hit **Import from AfkWarden** and paste a preset exported from AfkWarden's save-icon dialog
(the whole `afkscape_presets` blob works too).

**Chat alerts need in-game message timestamps enabled.** Chat is located by its `[HH:MM:SS]`
prefix, so with timestamps off nothing is read at all. Chat also goes unreadable while the box is
scrolled up.

An alert that cannot see what it needs shows a **no data** badge rather than failing quietly.

## Why

AfkWarden works well until it doesn't. Buff icons and chat messages get tracked correctly
sometimes and silently missed other times. Investigation found two independent structural causes —
neither of which is the capture method that most people blame:

1. **Reader positions are cached for the entire session.** Every reader locates the chatbox or buff
   bar exactly once and never re-validates. Any window resize or UI-scale change afterwards leaves
   every dependent alert permanently reading the wrong region, with no error and no recovery until
   the app is restarted.

2. **Buff templates erode toward a hard cutoff.** Matching requires 50 matching pixels, and every
   successful match re-masks the stored template — a ratchet that only ever removes pixels. Real
   templates measured in the wild sit as low as 53 opaque pixels: three above the floor.

AFK Goblin fixes both at the architecture level. See
[`docs/superpowers/specs/2026-08-05-afkuav-design.md`](docs/superpowers/specs/2026-08-05-afkuav-design.md)
for the full analysis.

## What's different

- **Self-healing readers** — positions are invalidated on resize, UI-scale change, `rslinked`, and
  after consecutive failed reads. Reader health is visible per-alert rather than buried.
- **All chatboxes monitored** — the underlying library already detects every open chatbox but only
  ever reads one. AFK Goblin reads them all, at the cost of a single screen capture per tick.
- **Immutable buff templates** with relative-coverage scoring, so sparse templates aren't
  structurally disadvantaged and can't decay.
- **No backend.** Custom sounds and text-to-speech run locally; nothing calls out to a server.
- **Real alert grouping**, replacing the widespread workaround of using empty alerts as section
  headers.

## Feature parity

Target is all 16 shipping AfkWarden alerter types — plus preset management, per-alert pause, global
settings, and quick-add premades.

| Type | Status |
| --- | --- |
| `inactive` | ✅ |
| `chat` | ✅ |
| `actionbar` | ✅ |
| `buffs` | ✅ |
| `xpcounter` | ✅ |
| `bigxp` | ✅ |
| `clockbased` | ✅ |
| `dialogtextsimple` | ✅ |
| `targetdeath` | ✅ |
| `drops` | ✅ |
| `craftmenu`, `sheathe`, `castlewars`, `fightkiln`, `summoning`, `necroritual` | needs a custom reader |

Ordered by how much they actually get used: these cover 106 of the 108 alerts in the config this was
developed against. Chat alone is 67%.

The six remaining types read the screen through `@runeapps/common/readers/*` — RuneApps' private
modules, which are not in the published `alt1` package. Each needs a reader written from scratch,
including needle images captured from a live client.

Alerts of a type that isn't implemented yet still import — they show an error badge rather than
disappearing.

Existing AfkWarden presets import directly.

**Not included:** toilet mode (phone streaming), arbitrary screen-region OCR.

## Stack

Lua (detection) · TypeScript · Preact · zod · Vite

Detection runs as Lua inside the game process and pushes state snapshots; rule evaluation, storage
and the whole UI run in an embedded browser, so the Lua layer deliberately holds the least logic.
It is tested too: `tests/lua/` boots `main.lua` in a real Lua 5.4 VM against a fake Bolt host and
drives it frame by frame. See
[`docs/superpowers/specs/2026-08-06-bolt-migration-design.md`](docs/superpowers/specs/2026-08-06-bolt-migration-design.md).

## Development

```sh
npm install
npm run build
```

The repo root **is** the plugin directory — `bolt.json`, `main.lua`, `lua/` and the built `app/` —
so there is no packaging step while developing. Point Bolt at `bolt.json` via *add from file* and
the loop is `npm run build`, then restart the plugin.

### Testing the Lua

`tests/lua/` runs the real `main.lua`, `lua/bridge.lua`, `lua/json.lua` and `lua/detect/*` inside a
Lua 5.4 VM ([wasmoon](https://github.com/ceifa/wasmoon)). Only the Bolt host and the two vendored
pixel-reading modules are faked, so a test can render a frame, let a tick pass, and assert on the
JSON that would have reached the browser — decoded through the real zod schema, which is what
catches a field Lua quietly stopped sending.

This exists because the bugs that actually shipped were in the *wiring* between Lua modules —
a list cleared one line before it was read, a scan window closed after the first chat box — and
none of them were visible to the browser-side tests or to a syntax check. Each cost a live play
session to find.

`app/probe.html` remains the bridge diagnostics page: handshake, tick rate, activity timers, both
message directions and config round-trip. It answers the questions a test cannot — whether
`plugin://` loads and whether Bolt really delivers what its docs say. CI also runs `luac -p` over
every Lua file, so a syntax error cannot ship as a dead plugin.

## Credit

AfkWarden is by [Skillbert](https://runeapps.org), who also wrote Alt1 itself and the `alt1`
library this project depends on. AFK Goblin is an independent reimplementation built against the
documented API — it contains no AfkWarden source.

## Licence

Undecided.
