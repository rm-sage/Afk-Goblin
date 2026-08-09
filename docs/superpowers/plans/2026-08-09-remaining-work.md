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
| ~~1~~ | ~~Chat colours over the bridge~~ | **71** (precision) | **done** — needs in-game confirmation |
| ~~2~~ | ~~XP drop detection → `xpcounter`, `bigxp`~~ | **1 of 4** | **done for Total** — see below |
| 2b | Attribute a drop to its skill by hashing the icon | 3 | a live reading; only if Total proves insufficient |
| 3 | Taskbar countdown / tooltip surface | 0 (a dropped feature, and a false README claim) | nothing |
| 4 | `craftmenu` | 1 | nothing |
| 5 | Model highlighting — enriched springs | 0 | two recorded colony sessions |
| 6 | `dialogtextsimple`, `targetdeath`, `drops` detection | 0 | nothing |
| 7 | `sheathe`, `castlewars`, `fightkiln`, `summoning`, `necroritual` | 0 (1 for `sheathe`) | a reader each |
| 8 | Release and install path verification | — | a push, then a clean install |

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

**Total only.** A drop is a skill icon beside a number, and the number cannot say which skill it is.
Everything accumulates under `tot`; an alert naming a specific skill reports itself unreadable rather
than quietly watching everything, and the skill field explains why. While you are doing one activity
Total is equivalent, which is why 2b is speculative rather than scheduled.

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
