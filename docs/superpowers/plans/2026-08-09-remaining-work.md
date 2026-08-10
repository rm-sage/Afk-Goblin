# Remaining work

**Date:** 2026-08-09
**Supersedes:** the "Build order" section of
[`2026-08-06-bolt-migration-design.md`](../specs/2026-08-06-bolt-migration-design.md), which is now
mostly done. That document remains the authority on architecture and on decisions not to be
reopened.

The Alt1-era [`2026-08-05-afkuav-core.md`](2026-08-05-afkuav-core.md) is **superseded** and kept only
as history — its Tasks 1–3 (RS geometry watch, ReaderAnchor, buff needle scoring) describe an
apparatus that Bolt made unnecessary rather than merely fixed.

## Done

Build order steps 1–5 and 8: bridge, engine seam swap, inactivity, chat, action bar, buffs, and the
record/replay harness. Plus, since:

- **Both buff detection paths.** Item-model buffs via `onrendericon`, sprite-drawn buffs (abilities,
  prayers, familiars) by reading the draw stream. Confirmed in game 2026-08-09: a full bar reads with
  correct timers.
- **A detection panel** behind the connection pill, and an on-demand draw-stream probe.
- **The Lua layer under test** in a real VM, plus a dialect guard — Bolt runs LuaJIT 2.1 (Lua 5.1)
  and the test VM is 5.4, so the two disagree by construction.

## Ordered by value, not by build order

Value is measured against the 108-alert reference config, because that is the only evidence available
about which alerts anyone actually uses.

| # | Work | Alerts it affects | Gated on |
| --- | --- | --- | --- |
| ~~1~~ | ~~Chat colours over the bridge~~ | **71** (precision) | **done** — still unconfirmed in game |
| ~~2~~ | ~~XP, from the counter interface~~ | **4** | **done, confirmed in game** — Total only |
| ~~3~~ | ~~Smooth progress bars, un-stale the idle timers~~ | 13 (`inactive`) | **done** |
| 4 | Release and install path verification | — | **a push**, then a clean install |
| 5 | Attribute an XP row to its skill by hashing the icon | 3 | a live reading — and probably not worth it, see below |
| 6 | `craftmenu` | 1 | a live reading of the crafting interface |
| 7 | In-game countdown surface (replaces the dropped taskbar one) | 0 | a design decision |
| 8 | Model highlighting — enriched springs | 0 | two recorded colony sessions |
| 9 | `dialogtextsimple`, `targetdeath`, `drops` detection | 0 | a live reading each; `drops` also needs the event reshape |
| 10 | `sheathe`, `castlewars`, `fightkiln`, `summoning`, `necroritual` | 0 (1 for `sheathe`) | a reader each |

**The reference config is now functionally covered.** 106 of its 108 alerts work — chat, inactivity,
the action bar, buffs and XP are all confirmed against a live client. The two that are not are
`craftmenu` and `sheathe`, one alert each. So everything below the release row is either polish, a new
capability, or work for alerts nobody in this config has.

That changes what "highest value" means: the biggest risk to this project is no longer a missing
feature, it is that **CI has never run on any of it** — 30 commits, including a LuaJIT byte-compile
step added specifically because a green test suite failed to catch a plugin that would not start.

Note the ordering departs from the migration spec, which put model highlighting at step 6 ahead of
XP. That ordering was by *motivation* — highlighting is why the migration happened. This one is by
alerts unblocked. Highlighting stays late for the reason the spec gives: it is the only item whose
duration cannot be estimated in advance.

### 1. Chat colours

`main.lua` sends `colors = {}` on every line and the browser treats an empty list as *unknown*,
declining to filter rather than treating it as a mismatch — which was the right call, since the
alternative silences every colour-filtered alert. But 71 of 74 chat alerts carry a colour filter, so
for almost the whole config the filter is inert and the same text in a different colour fires it.

The vendored chat module reads text and reports no colour, so this means reading the glyph vertex
colour per fragment alongside it. Keep empty-means-unknown, so an older plugin against a newer UI
degrades to today's behaviour rather than going silent.

### 2. XP drops — done for Total

There was never a glyph blocker. The vendored chat module already carries `+`, every digit, `,`, `.`,
`k` and `m` across all seven font sizes, because since the 2026-01-19 interface update most game text
uses the chat font. `lua/detect/xp.lua` reads drops with the same lookup chat uses.

**Total only, and the follow-up is probably not worth building.** Each counter row carries a skill
icon, and identifying it means hashing the sprite — the technique sprite buffs already use — plus a
one-time picker binding each hash to one of AfkWarden''s three-letter codes. But the user would have to
do a binding step either way, and switching three alerts to Total is strictly less work than binding
three icons. Since Total is equivalent while doing a single activity, per-skill buys accuracy nobody
has asked for. Left in the table as a known option, not a plan.

**Superseded: reading the floating "+N" drops.** It worked but lagged about five seconds, because a
drop is redrawn while it fades and so was counted again on every tick until it vanished. Confirmed in
game as killing the feature for time-sensitive activities. Deduping across ticks was never available —
two genuine identical drops would collapse and the alert would fire DURING activity.

Two guards against reading ordinary text as XP, both because a false drop resets an inactivity timer
and *delays* the alert — the failure direction that matters: only a `+` opens a run and the run admits
nothing but digits, separators and a `k`/`m` suffix; and the scan is kept off any batch chat claimed,
since chat and drops share the font.

A drop lingers across ticks, so the total over-counts and cannot under-count. That delays an
inactivity alert by roughly a drop's on-screen lifetime.

### 3. Taskbar countdown and tooltip

`src/main.tsx` carries `TODO(P1.5)`: both were Alt1 APIs with no Bolt equivalent and were dropped.
Tooltips are still collected so nothing depends on them vanishing. Bolt can draw surfaces into the
game view, which is a better home for both than the taskbar ever was. The README still claims the
taskbar countdown works, which is false and should be corrected whether or not the feature returns.

### 5. Model highlighting

Needs an instrumentation mode logging `vertexcount`, `vertexpoint(1)` and `animated()` per distinct
signature across `onrender3d`, `onrenderbillboard` **and** `onrenderparticles` — divination wisps are
particle-heavy, so a spring may not be a plain model, and bolt-alerts tracks billboards separately
for that reason. Then two recorded colony sessions, one with a spring and one without.

## Not in scope, by decision

Do not reopen these as part of this work:

- **Keyboard activity.** Bolt exposes no key events; adding them means patching and self-building
  Bolt. Activity is mouse-derived, which matches or beats Alt1's click-only `rsLastActive`.
- **Toilet mode** (phone streaming) and **arbitrary screen-region OCR**.
- **`bolt.isfocused()` on Windows.** Always false — Bolt calls `GetFocus()` from the render thread.
  Fails safe (alerts are never suppressed rather than silenced). Worth reporting upstream as a
  one-line fix; do not build anything that fails dangerously when it is wrong.
