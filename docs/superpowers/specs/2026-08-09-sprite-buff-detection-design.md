# Sprite-drawn buff detection — design

**Date:** 2026-08-09
**Status:** approved design, not yet planned
**Extends:** [`2026-08-06-bolt-migration-design.md`](2026-08-06-bolt-migration-design.md), which remains the authority on the Bolt architecture, and [`2026-08-05-afkuav-design.md`](2026-08-05-afkuav-design.md) on alerter semantics.

## Problem

Roughly half the buff bar is invisible to the plugin, and no amount of pairing work reaches it.

`lua/detect/buffs.lua` builds its candidate list exclusively from `onrendericon`. Bolt raises that
event only for images it recognised as a rendered 3D item model: its capture happens at the 64x64
item-icon render target, and an icon event is split out of a batch only when a quad's atlas rect
matches one it captured. Potions, food and charged items qualify. Anything drawn from a plain
authored sprite raises nothing at all, so it cannot reach `pending` and cannot be detected however
well the pairing above it works.

Measured on a live bar, 2026-08-07 — six buffs at a 30px pitch, three of which produced an icon
event:

```
1456  "60"                   no icon event
1486  "15hr"                 no icon event
1516  "2K"    -> 1:366       icon, text unreadable
1546  (none)  -> 1:321       icon, genuinely no timer
1576  "8m"    -> 1:18        icon, read as 480s
1606  "56m"                  no icon event
```

`M.outlinecount` already measures the gap: every buff on the bar is outlined whether or not it
raises an icon, so outlines-minus-icons is the size of the blind spot.

The reference config carries seven `buffs` alerts. Which of them land in the blind spot is
**not inferable from their names** — those are user labels carried over from AfkWarden, some of
which predate game changes — and this design deliberately makes the answer measurable per buff
rather than guessed. What is known is the ratio above: half a real bar was unreachable.

## Decision

Add a **second detection path** alongside the icon path, using the pattern
`modules/buffs/README.md` documents and this codebase has never used: walk the images of a
`render2d` batch directly and ask the vendored module about the ones that could be a buff.

Keep the icon path. It is not redundant — Bolt removes a recognised item-model quad from the batch
to raise its icon event, so the two paths see disjoint sets of buffs.

Identity for sprite buffs comes from **hashing the sprite's own pixels**, and new ids are
**additive**: existing `models:verts` ids keep working, so there is no config migration. This is a
departure from the note left in `lua/detect/buffs.lua`, which assumed the id format would have to
change wholesale.

## Detection

Two passes over each `render2d` batch, both inside the existing scan budget:

```
pass A   scanoutlines(event)              -- already exists
pass B   for i = 1, vertexcount, verticesperimage
           if textured and outlineat(vertexxy(i + 2)) then
             tryreadbuffdetails(event, i + verticesperimage, x, y)
```

Two passes rather than one because a buff's outline is drawn *after* its icon within the batch, so
the outline set has to be complete before any image can be judged a candidate.

**The filter is an exact equality, not a heuristic.** The module's own validity test is that an
outline quad sits at precisely the icon's top-left (`modules/buffs/buffs.lua:85`). Pass B checks
that same equality earlier, purely to decide what is worth attempting. This matters for cost: an
unfiltered attempt-per-image was measured at 2,366 parse attempts per frame and was worth five to
ten FPS. Bounded this way it is one attempt per buff on the bar.

The module still adjudicates. Pass B cannot invent a buff; it can only surface one we were
previously not asking about.

`wipoutlines` holds every outline *segment* position, four per box. Only the top-left of a box will
ever coincide with an image origin, so the extra three are inert.

### Interaction with the icon path

A buff must not arrive twice under two ids. Bolt splits a recognised item-model quad out of the
batch, so in principle the two paths cannot both see one buff — but that is a claim about Bolt's
internals, so pass B additionally skips any position already claimed by a paired icon this tick.

## Identity

`s:<hex>`, from an FNV-1a hash of the sprite's atlas pixels read through `event:texturedata`:

- sampled on a fixed **8x8 relative grid** across `aw x ah`, so two draws of one sprite at
  different interface scales sample corresponding points rather than corresponding offsets;
- each sample **quantised to the top 4 bits per channel**, to absorb filtering noise;
- **cached per atlas rect for the session**, so the cost is one read per distinct buff rather than
  per frame.

Atlas rects are packed at runtime and are not stable between sessions, which is why the pixels are
hashed rather than the rect.

**CONFIRMED IN GAME 2026-08-09:** a full bar reads, with correct timers, on both paths. So the hash
does identify sprites stably within a session. What remains unverified is only whether it survives an
**interface-scale change** — if the atlas holds a variant per scale, ids move and alerts bound to
them stop matching.

The atlas rect and drawn size each id was derived from are published in `diag` — not on `BuffSlot`, which is on the hot path
and read by alerters that have no use for them — and the detection panel shows them beside the id.
An id that moves when it should not is then visible in one glance, rather than inferred from an
alert that quietly stopped firing. If the hash proves unstable across interface scales, only the id
scheme needs revisiting; the detection above is unaffected.

## Wire and UI

`BuffSlot` gains two defaulted fields, so an older plugin against a newer UI still decodes:

| field | meaning |
| --- | --- |
| `slot` | left-to-right index on the bar, derived from x |
| `source` | `"icon"` or `"sprite"`, so the blind spot is measurable per buff rather than in aggregate |

`slot` exists for the picker. With a full bar visible, a list of opaque hashes is materially harder
to choose from than the three-entry list it replaces, so the picker lists buffs in bar order and
names the position — "third along" is how a person identifies a buff on screen.

The detection panel already contrasts `buffOutlines` against buffs read. With `source` it can say
which mechanism found each one, which turns the remaining gap — if any — into a specific claim.

## Testing

`tests/lua/driver.lua`'s fake buff module already dispatches on `startindex`, so the sprite case is
expressible without reworking it. It needs one addition: a batch laying out icon → text → outline
within a single event, so a test can assert the sprite path finds a buff the icon path structurally
cannot.

Cases to hold down:

1. A sprite buff in a batch with no icon event at all is read, with its timer.
2. A sprite buff whose text will not parse is still published, with a null `timeLeft` — the outline
   fallback that already exists for icon buffs must not regress for sprites.
3. An image drawn at a position with no outline is never attempted, so the cost bound is real and
   not merely intended.
4. A buff seen on both paths is published once.
5. Two sprites with different pixels get different ids; the same sprite drawn twice gets one id.

## What this does not address

- **Timer text that the vendored module cannot parse.** `"2K"` remains unreadable: `multipliers`
  declares `k = 1000`, but no glyph in either font table maps to `'k'`, so the handler is
  unreachable. Such buffs are published present-with-no-timer, which is already the behaviour.
- **Buffs the player has disabled in their interface.** Nothing is drawn, so nothing is readable.
- **Naming buffs.** Ids stay opaque; `slot` is the concession to usability. A user-supplied label
  per buff is a reasonable follow-up and is deliberately out of scope here.
