# AFK Goblin — Design

**Date:** 2026-08-05
**Status:** Approved (pending spec review)

A modern replacement for the RuneScape 3 Alt1 Toolkit plugin **AfkWarden**, keeping full feature
parity, rebuilding the UI, adding multi-chatbox monitoring, and fixing two reliability defects that
make the original intermittently unusable.

---

## 1. Goal and non-goals

**Goal.** Reproduce every AfkWarden alerter type and workflow, on a modern UI, with no server
dependency, importing the existing AfkWarden configuration.

**Non-goals.**

| Excluded | Reason |
| --- | --- |
| Toilet mode (WebRTC screen streaming to phone, QR pairing) | Explicitly dropped by the user. It is the only feature requiring a backend. |
| Arbitrary screen-region OCR | Was the fallback for chatbox designation being hard. It is not hard. Region OCR is the least reliable subsystem available and buys nothing here. |
| `overheadprogress` alerter | Implemented in AfkWarden but commented out of its registry (`Alerter.ts:987`); it does not ship, so parity does not require it. |
| Public distribution / general-purpose migration tooling | Personal build. The repo is public, but import only needs to work for one known config. |

Dropping toilet mode is what makes AFK Goblin **fully static with zero backend**.

---

## 2. Background: what AfkWarden actually is

Established by inspecting the live app, its published sourcemap, and the local Alt1 install
rather than from documentation.

- **URL / origin:** `https://runeapps.org/apps/alt1/afkscape/` — internal codename `afkscape`.
  First-party RuneApps app by Skillbert, author of Alt1 itself. Not a community plugin.
- **Manifest:** `permissions: "pixel,gamestate,overlay"`, `defaultWidth 220`, `defaultHeight 138`,
  `maxWidth 300`, `maxHeight 500`, `activators: ["Rest"]`.
- **Stack:** TypeScript → webpack → single ~1.0 MB `scripts.bundle.js`. No UI framework; hand-rolled
  DOM helpers plus a custom typed schema system that auto-generates settings forms. Styled with
  RuneApps' internal `nis.css` / `skinstyle.css`, which is why it looks dated.
- **Library:** the **unscoped** `alt1` npm package (0.1.3). Not the stale scoped `@alt1/*` packages.
- **Source recoverability:** `scripts.bundle.js.map` is published with `sourcesContent`, exposing all
  six original TypeScript files. The bundle carries **no software licence**. Behaviour is therefore
  fully knowable, but AFK Goblin reimplements from observed behaviour and the documented API rather
  than copying source.
- **Persistence:** four plain `localStorage` keys under `https://runeapps.org` —
  `afkscape_presets`, `afkscape_autosave`, `afkscape_settings`, `afkscape_customsounds`.
- **Host runtime:** Alt1 1.6.0 embeds CefSharp / **CEF 108.4.13 (Chromium 108.0.5359.125)**.

### 2.1 Feature inventory — 16 live alerter types

From the registry at `Alerter.ts:972-992`. Three further classes exist but are commented out
(`artisansworkshop`, `overheadprogress`, `broadcasts`).

| # | id | Display name |
| --- | --- | --- |
| 1 | `inactive` | Inactive |
| 2 | `xpcounter` | XP counter inactivity |
| 3 | `bigxp` | Big XP drops |
| 4 | `chat` | Chatbox |
| 5 | `craftmenu` | Crafting menu |
| 6 | `drops` | Item drops |
| 7 | `buffs` | Buffs |
| 8 | `actionbar` | Action bar stats |
| 9 | `sheathe` | Sheathe stance |
| 10 | `castlewars` | Castle Wars |
| 11 | `dialogtextsimple` | Dialog box |
| 12 | `fightkiln` | Fight kiln waves |
| 13 | `targetdeath` | Target death |
| 14 | `summoning` | Summoning |
| 15 | `clockbased` | Periodic events |
| 16 | `necroritual` | Necromancy Rituals |

Non-alerter features that also require parity: preset management (save / save-as / load / delete /
export / import), per-alert pause, global settings (suppress-while-active, global alarm, volume,
mute), per-alerter "functional" state, per-alerter tick divisors on a 600 ms master loop, quick-add
premade alerters, and per-preset option sets.

### 2.2 Alerter data shape

Common to every alerter: `name`, `type`, `globalalarm`, `alarm {sound, repeat}`, `voice`,
`tooltip`, `exportbar`. Type-specific fields include `delay`, `treshold` *(sic)*, `skill`,
`lines[{text, percent}]`, `colors[[r,g,b]]`, `resetonactive`, `bufftype`, `starttime`, `endtime`,
`stat`, `higherlower`, `triggerpercent`, `triggerstance`, `triggerdif`.

The misspelling `treshold` is preserved in the **import mapper only**; the internal model uses
`threshold`.

### 2.3 The config being migrated

15 presets, 108 alerters. Extracted from Alt1's CEF LevelDB and preserved at
`RS3\AfkWarden-backup-2026-08-05\`.

Distribution by type: **chat 74**, inactive 13, actionbar 8, buffs 7, xpcounter 4, craftmenu 1,
sheathe 1. Chat alerters are **67% of the total**, which is what makes the chatbox work the
highest-value change in this project.

Two observations that drive UI decisions:

- In the Zuk preset, **20 of 33** chat alerters share an identical 7-colour set. Colour filtering is
  not discriminating anything there; text matching does all the work.
- Three alerters have **zero match lines** and exist purely as section headers
  (e.g. `"Pause all the below alerts if using Elder Overload Salve"`). That is a workaround for a
  missing grouping feature.

---

## 3. Root cause analysis: why AfkWarden is unreliable

The user reports buff icons and chat messages being tracked correctly sometimes and not others, and
suspected the DirectX capture method. Investigation found **two independent structural defects**.
Neither is the capture method.

### 3.1 Reader positions are cached for the entire session

Every shared reader wrapper (`scripts.ts:255-368`) and every in-alerter reader uses this idiom:

```js
let tryFind = function () {
    if (reader.pos) { return true; }        // once found, never re-finds
    if (tickcount == lastfindattempt) { return false; }
    lastfindattempt = tickcount;
    reader.find();
    return !!reader.pos;
};
```

A search of all three application source files finds **no assignment that clears `.pos`**, no
`rslinked` / `rsunlinked` handler, no `rsWidth` / `rsHeight` / `rsScaling` polling, and no
invalidation after failed reads. Alt1 exposes no resize event either (its nine event types are
`alt1pressed`, `menudetected`, `rslinked`, `rsunlinked`, `permissionchanged`, `daemonrun`,
`userevent`, `rsfocus`, `rsblur`).

**Consequence.** Each reader locates the chatbox or buff bar exactly once per session and reads that
fixed rectangle forever. Any window resize, UI-scale change, or interface-layout change afterwards
leaves every dependent alerter permanently reading the wrong region — silently, with no error and no
recovery until the app is closed and reopened.

This explains the intermittency across **both** chat and buffs, since they share the pattern.

### 3.2 Buff needles erode toward a hard threshold

`BuffReader.matchBuffMulti` (alt1 buffs library):

```js
if (bestscore < 50) { return null; }        // hard floor: 50 matching pixels
if (buffinfo.canimprove) {
    BuffReader.isolateBuffer(...);          // re-masks the stored template
}
```

`final` is computed as `!!id && !canimprove`. All seven of the user's buff alerters have
`buffid: ""`, so `final` is always false: they take the scoring path *and* are re-masked on every
successful match. Because `isolateBuffer` only removes pixels, this is a ratchet — templates decay
monotonically toward the 50-pixel floor and then begin failing intermittently.

Measured opaque-pixel counts of the stored 25×25 needles (all hard binary masks, zero partial alpha):

| Needle | Opaque px | Coverage | `canimprove` |
| --- | --- | --- | --- |
| Overload timer | **53** | 8% | false |
| Spirit Pot | 91 | 15% | true |
| Perfect Plus | 125 | 20% | true |
| Juju Mining Pot | 131 | 21% | true |
| Familiar timer (WC) | 218 | 35% | true |
| Familiar timer (Div) | 215 | 34% | true |
| Aura (2 hr) | 504 | 81% | true |

The Overload needle sits **three pixels above the cutoff**.

**Falsifiable predictions.** (a) Resizing the RS3 window while AfkWarden is working should break chat
and buff detection permanently until the app is reopened. (b) Buff reliability should rank
Overload ≪ Spirit Pot < Perfect Plus < Juju < Familiar < Aura.

### 3.3 Where the capture method does matter

DirectX capture is not the root cause, but it is a contributing factor: a torn or stale frame at the
single moment `find()` runs locks a bad position in for the session. `compatibleAutoToggle = True`
also lets Alt1 switch methods mid-session. This is why changing capture method never reliably helped
— it slightly improves the odds of a good first find but cannot fix the permanence.

---

## 4. Architecture

### 4.1 Stack

TypeScript + Preact + zod, bundled with **Vite**, against unscoped `alt1@0.1.3`. Zero backend, fully
static, hosted from this repo.

- **Preact** — 4 KB runtime, no compat shims, suits a small always-on window on old Chromium.
- **zod** — AfkWarden's most tedious surface is hand-rolling settings forms for 16 alerter types. A
  schema that both validates and drives form generation collapses that.
- **Vite** — carries one unverified risk (whether the `alt1` package resolves cleanly outside
  webpack). The commonly cited font-loader blocker is **false**: `dist/fonts/*` ship as prebuilt UMD
  modules and the official docs import them directly. Loaders are needed only under the
  `alt1-source` export condition or when generating a new font. **Webpack is the proven fallback**
  and this is spiked before anything is built on it.

`alt1/base` exports `PasteInput`, so readers can be developed and tested in an ordinary browser
against pasted screenshots. Almost nothing requires running inside Alt1.

### 4.2 Modules

```
alt1-io/     thin wrappers: capture, overlay, tooltip, events, taskbar
readers/     self-healing reader layer + ChatboxPool
alerters/    16 modules — one per type: zod schema + check() + metadata
engine/      600ms tick loop, lifecycle, trigger latch, suppression
alerting/    sound / TTS / tooltip / overlay outputs
store/       presets, settings, sounds
import/      AfkWarden JSON -> internal model
ui/          Preact components
```

Nothing outside `alt1-io/` imports `alt1` directly. That boundary is what makes the rest
unit-testable without the host.

### 4.3 Self-healing reader layer

Directly addresses §3.1. Every reader is wrapped in an anchor that owns its position and decides
when that position is stale. Invalidation triggers:

1. Polled change in `alt1.rsWidth`, `alt1.rsHeight`, or `alt1.rsScaling`.
2. `rslinked` event.
3. N consecutive empty or failed reads (self-healing without any external signal).
4. A periodic TTL as a backstop.

Re-finding costs a few milliseconds. A silently dead alert costs a boss kill. The trade is not close.

Reader health is part of the public state of every alerter, not an internal detail.

### 4.4 ChatboxPool — monitor all chatboxes

The requested feature, resolved to its simplest correct form. AfkWarden's reader already detects
every chatbox (`find()` returns `{mainbox, boxes}`) but `read()` only ever consumes `pos.mainbox`.

AFK Goblin keeps **one `ChatBoxReader` per detected box**, so diff state is naturally per-box rather than
something to remember to reset. Each tick:

1. One `captureHoldFullRs()`, shared by every reader — N boxes cost **one** screen grab, because
   `read(imgref)` slices from a supplied capture instead of grabbing its own.
2. Re-sync the pool when `find()` results change. `find()` reassigns `this.pos` and re-picks
   `mainbox` itself, so any designation must be re-applied after **every** `find()`.
3. Recompute the colour union from currently-active chat alerters **each tick**. A cached snapshot
   silently drops colours when the preset changes.
4. Emit a deduped union of new lines.

Monitoring all boxes rather than designating one removes the box-identity problem entirely: box
ordering is unstable because `boxes` is three concatenated detection passes grouped by collapse
state, so a stored index reshuffles whenever any box is collapsed or expanded.

Consumers see one line stream, so the alerter layer is unchanged. Per-box cost is unmeasured and is
a tracked risk; typical box counts are 1–3.

### 4.5 Buff matching

Directly addresses §3.2.

- Needles are **immutable** once captured. No erosion ratchet.
- Scoring is a **fraction of the needle's own opaque pixels**, not an absolute count, so a sparse
  template is not structurally disadvantaged.
- Observed variants are kept as a **set**, not destructively intersected.
- Known `buffid` sprites are preferred where they exist; custom needles are the fallback.
- The UI warns when a needle's coverage is near threshold.

---

## 5. Data model and import

The internal model is clean and versioned. **AfkWarden's `{alerters, name, baseName}` shape is an
import format, not the storage format.**

Storage keys are namespaced `afkw2_*` and must never reuse `afkscape_*`: origin is
`(scheme, host, port)`, so every Alt1 plugin on one `github.io` account shares a single localStorage
bucket, and at least one existing AfkWarden fork already squats those exact key names.

Audio moves to IndexedDB blobs. The eight custom sounds currently resolve to
`https://runeapps.org/i/<id>.mp3`; the original `.wav` files exist locally in `RS3\Sounds` with
exactly matching names and are embedded at import. TTS moves from `runeapps.org/node/speech/sound`
to the Web Speech API — Windows SAPI voices are present on the target machine, pending confirmation
that CEF 108 exposes them.

**After import, no runeapps.org dependency remains.**

Unlike AfkWarden's importer, which swallows bad input
(`console.log("invalid import"); //TODO feedback`), this importer validates against the zod schemas
and reports failures visibly.

---

## 6. UI

Two surfaces, because one window cannot be both:

- **Runtime view** — compact, always-on. Alerter rows with progress bars, pause toggles, and live
  reader-health state.
- **Editor** — roomy. Preset management and alerter editing with a **live read preview** showing
  what is actually being matched.

The redesign adds **real groups/sections**, replacing the empty-alerter-as-header workaround
(§2.3). With 33 alerters in the Zuk preset this is the difference between usable and not.

Chromium 108 constraints: CSS grid, `:has()`, container queries, and `<dialog>` are available.
CSS nesting, `oklch()`, `color-mix()`, subgrid, and the popover API are **not**. Target `chrome108`.

---

## 7. Testing

- **Unit** — everything not touching Alt1: schemas, import mapping, trigger latches, colour union,
  anchor invalidation logic.
- **Reader integration** — saved PNG fixtures replayed through `PasteInput` in an ordinary browser,
  so OCR behaviour is testable in CI. Fixtures live in `fixtures/`.
- **Manual in-Alt1** — reserved for the genuinely un-mockable: overlay rendering, permissions,
  window sizing.

Regression fixtures are captured specifically for the §3 defects: a resize sequence that must not
break detection, and a sparse-needle match that must not decay.

---

## 8. Build order

Spikes first, because two of them can invalidate design choices.

0. **Spikes (half day)** — does Alt1 honour a large `maxWidth`/`maxHeight`? does Vite resolve
   `alt1` cleanly? does `speechSynthesis` work inside CEF 108?
1. **Skeleton** — appconfig, tick loop, overlay, self-healing anchor, `inactive` alerter end to end.
2. **ChatboxPool + `chat` alerter** — covers 67% of the user's alerters.
3. **Importer** — the 15 real presets load and validate.
4. **Remaining 14 alerter types.**
5. **UI polish.**

Steps 1–3 produce something genuinely usable; step 4 is the long tail.

---

## 9. Risks and open questions

| Risk | Status | Mitigation |
| --- | --- | --- |
| Alt1 honouring `maxWidth`/`maxHeight` above 300×500 | **Unverified** | Spike 0; UI degrades to compact-only if capped |
| Vite resolving the `alt1` package | **Unverified** | Spike 0; webpack fallback |
| `speechSynthesis` inside CEF 108 | Likely — SAPI voices confirmed present | Spike 0; fall back to pre-rendered audio |
| N-way chatbox OCR cost per tick | **Unmeasured** | Measure at step 2; cap pool size if needed |
| Only one bound image per app | Known constraint | Never hold an `ImgRefBind` across ticks |
| Full-client capture exceeds 4 MB `maxtransfer` | Known | Use `captureAsync`; handle per-region `null` |
| Silent wrong-region reads | Root cause §3.1 | Self-healing anchors + visible reader health |
| Licensing of recovered AfkWarden source | Bundle carries no licence | Reimplement from behaviour and documented API; do not copy |

Undecided: repository licence for AFK Goblin itself.
