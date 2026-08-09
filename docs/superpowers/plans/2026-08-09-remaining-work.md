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
| 1 | Chat colours over the bridge | **71** (precision) | nothing |
| 2 | XP drop detection → `xpcounter`, `bigxp` | **4** | a live reading of the '+' glyph |
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

### 2. XP drops

`GameState.xp` is never populated. `registry.ts` records the blocker as identifying the XP-drop '+'
glyph against a live client; the probe now exists to answer exactly that. bolt-alerts is a documented
reference for the technique — **GPL2, so patterns only, never code**.

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
