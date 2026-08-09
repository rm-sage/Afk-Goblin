-- Buff and debuff detection, wrapping the public-domain bolt-buffmodule.
--
-- IDENTITY IS A DISCOVERED SIGNATURE, NOT A LOOKUP TABLE.
--
-- bolt-alerts names each buff via a table mapping the vertex count of its icon
-- model to a hard-coded name -- seventy-odd entries built by hand against a live
-- client, in a GPL2 project. Copying it is off the table, and rebuilding it
-- would mean cataloguing every buff in the game before any of them worked.
--
-- So the signature IS the id: "<modelcount>:<vertexcount>". It is stable for a
-- given buff, needs no table, and works for buffs nobody has catalogued --
-- including Juju Mining Pot, the one buff in the reference config that
-- bolt-alerts does not know. The user labels it once in the picker, which they
-- were going to do anyway when choosing which buff to watch.
--
-- WHAT A LIVE BAR ACTUALLY LOOKS LIKE, MEASURED 2026-08-07. Six buffs, 27x27
-- icons at a 30px pitch, and only THREE of them ever reached this file:
--
--   1456  "60"    Greater Bone Shield  no icon event
--   1486  "15hr"                       no icon event
--   1516  "2K"    -> 1:366             icon, text unreadable
--   1546  (none)  -> 1:321             icon, genuinely no timer
--   1576  "8m"    -> 1:18              icon, read as 480s
--   1606  "56m"                        no icon event
--
-- TWO SEPARATE LIMITS, AND THE SECOND IS THE BIG ONE.
--
-- 1. "2K" cannot be parsed, and never will be by the vendored module. Its
--    `multipliers` table declares k = 1000, but NO GLYPH IN EITHER FONT TABLE
--    MAPS TO 'k' -- the codomain is exactly {0-9, '(', 'm', 'h', 'r', '%'}, so
--    that handler is unreachable. lookupchar returns nil, handlers[nil] is nil,
--    and modules/buffs/buffs.lua:100 returns a bare false. Hence the outline
--    fallback below: the timer is lost, the buff is not.
--
-- 2. HALF THIS BAR IS INVISIBLE, and no amount of pairing work reaches it. Bolt
--    raises onrendericon only for images it recognised as a rendered 3D item
--    model -- Bolt's gl.c captures model data only at the 64x64 item-icon render
--    target, and splits an icon event out of a batch only when a quad's atlas
--    rect matches one it captured. Potions, food and charged items qualify;
--    abilities, prayers, auras and familiars are plain authored sprites and
--    raise nothing at all. Since `pending` is built from onrendericon and
--    nothing else, those buffs cannot be detected however well this file works.
--    `M.outlinecount` measures the gap, because every buff is outlined whether
--    or not it raises an icon. Closing it means detecting from render2d and
--    taking identity from the sprite's PIXELS -- atlas rects are packed at
--    runtime and are not stable between sessions -- which changes the id format
--    and needs a config migration. That is a design change, not a patch.
--
-- READING SPANS THE WHOLE TICK, NOT ONE SAMPLED FRAME.
--
-- Icons are offered by onrendericon and their timer text arrives on a later
-- render2d, and there is no promise the game draws a given icon on any
-- particular frame. Sampling a single frame per tick therefore reads whatever
-- happened to be drawn in that one frame and calls everything else absent. So
-- every frame contributes, and a signature already read this tick is skipped --
-- which bounds the cost to one text parse per distinct buff per tick rather
-- than one per icon per frame.

local buffmodule = require("modules.buffs.buffs")

local M = {}

--- Icons drawn since the last render2d, each waiting to be paired with the text
--- that follows it.
---
--- A LIST, not one slot. The module's contract is that an icon's details arrive
--- on the next render2d, but nothing says only one icon is drawn between two of
--- them — and the buff bar draws ten in a row. Keeping a single slot meant every
--- icon but the last was discarded before it could be read, silently and in the
--- same order every frame, so the same buffs went missing every time.
---
--- Trying all of them is safe rather than a guess: tryreadbuffdetails checks the
--- outline's position against the one it is handed, so only the icon the text
--- actually belongs to can match.
local pending = {}

--- render2d events an unmatched icon is carried across before being given up on.
---
--- CONFIRMED TOO SMALL AT 4. A live draw stream showed the buff bar drawing all
--- of its icons in a run and their text in the batches afterwards, so an icon
--- needs to survive roughly one batch per buff on the bar. At four, only the
--- first few buffs could ever pair -- six on the bar read as three, and the same
--- three every time. Thirty-two covers a full bar with slack.
local MAX_TRIES = 32

--- Icons kept waiting at once. Buff icons are drawn as a contiguous run, so the
--- most recent handful are the candidates; this stops an inventory full of items
--- from being carried along and retried.
local MAX_PENDING = 32

--- THE SIZE A BUFF ICON IS DRAWN AT, LEARNED RATHER THAN ASSUMED.
---
--- Carrying every icon across every batch costs one parse attempt per icon per
--- batch, and a live client draws two dozen icons and ninety batches a frame --
--- measured at 2,366 attempts per frame, which was worth five to ten FPS. But
--- most of those icons are inventory and interface items that could never be a
--- buff.
---
--- Buff icons are all drawn at one size, so the first one that parses says what
--- that size is, and everything of a different size can be dropped immediately
--- afterwards. Learned, because the size depends on interface scale and on the
--- buff bar's own settings -- exactly the sort of thing that has no business
--- being a constant in this file.
---
--- Nothing is filtered until something has been read, so a wrong guess cannot
--- lock detection out; and if a whole tick passes with nothing read, the filter
--- is dropped and learned again.
local iconsizes = {}
local sizecount = 0
local MAX_SIZES = 3

--- Ticks in a row that read no buff at all, before the learned sizes are thrown
--- away. One tick of an empty bar is normal; several mean the filter is wrong.
local IDLE_TICKS_BEFORE_RELEARN = 5
local idleticks = 0

local function sizekey(w, h)
  return string.format("%dx%d", w or 0, h or 0)
end

--- Whether an icon of this size could be a buff. True while nothing is known.
local function plausible(w, h)
  if sizecount == 0 then return true end
  return iconsizes[sizekey(w, h)] == true
end

--- Published lists, handed to the bridge on the tick. Empty is meaningful: it
--- means no buff was readable during the whole of the last tick.
local buffs, debuffs = {}, {}

--- The tick in progress. `seen` is keyed by signature so a buff drawn on every
--- frame is parsed once, and so it cannot appear in the list twice.
local wipbuffs, wipdebuffs = {}, {}
local seen = {}

--- Diagnostics. "No buffs are active" has three very different causes -- no icon
--- events arriving at all, icons arriving whose text will not parse, or a
--- genuinely empty bar -- and an empty list cannot tell them apart.
---
--- `icons` counts EVERY icon the game drew, not just buff icons: inventory and
--- interface items come through the same event. A zero therefore means
--- onrendericon is not firing at all, which is a different order of problem from
--- a buff icon that will not parse.
local icons, parsed = 0, 0
local wipicons, wipparsed = 0, 0

--- Pairing attempts made. This is the cost of carrying icons across batches, and
--- it is published so raising MAX_TRIES stays a measured decision rather than a
--- hopeful one.
local attempts, wipattempts = 0, 0

--- Buff and debuff outline colours, restated from modules/buffs/buffs.lua:2-7,
--- which does not export them. Confirmed present in a live draw stream on
--- 2026-08-07 as `flat 27x1 #5a9619` — 0x5a,0x96,0x19 is exactly (90,150,25).
local OUTLINE = {
  { r = 90, g = 150, b = 25, isbuff = true },
  { r = 204, g = 0, b = 0, isbuff = false },
}

--- Outline boxes seen this tick, keyed "x,y" -> true for a buff, false for a
--- debuff. Plus how many distinct ones there were.
---
--- WHY THE WRAPPER LOOKS FOR THESE ITSELF, rather than leaving it to the module.
---
--- The module answers one question — "read this buff" — and answers it false for
--- at least five different reasons, none of which it reports: the outline was not
--- exactly where it was told, its colour was not exactly one of the two, a glyph
--- would not resolve, its stride ran off the end of the batch, or it raised. Four
--- of those five are about the TEXT, and a buff whose text cannot be read is
--- still a buff that is ON. Gating presence on the timer parse meant one
--- unreadable glyph deleted the buff outright, forty-two times a tick.
---
--- It also walks in steps of `verticesperimage * 2`, on the assumption that every
--- glyph is a shadow-then-colour pair. One unpaired extra image anywhere in the
--- batch flips the parity of everything after it and the walk steps straight over
--- the outline. Scanning at a stride of ONE cannot miss it for that reason.
---
--- This is deliberately NOT a looser version of the module's test: the position
--- and colour comparisons below are the same exact equalities. A tolerance here
--- would be a fresh guessed constant papering over a real mismatch, which is the
--- mistake lua/detect/probe.lua exists to stop.
local outlines, wipoutlines = {}, {}
local outlinecount = 0

--- Distinct outline BOXES, from the segment positions gathered this tick.
---
--- COUNTING QUADS COUNTS EVERY BUFF FOUR TIMES, which is how this first shipped:
--- a bar of six buffs reported twenty-four, and the panel said so in words. The
--- game draws a box as four thin quads -- a 27x1 top, a 1x25 left, and the
--- matching bottom and right -- at four different positions.
---
--- A box's top-left is the one position with another segment directly beneath it,
--- where the top meets the left; the other three have nothing at y+1. That is
--- read off the geometry rather than divided by a guessed four, so a bar that
--- draws an extra segment or omits one still counts right. It is also the
--- position the vendored module matches an icon against
--- (modules/buffs/buffs.lua:85), which is what makes this number comparable to
--- the icon count at all.
local function countboxes(positions)
  local boxes, total = 0, 0
  for key in pairs(positions) do
    total = total + 1
    local x, y = string.match(key, "^(-?%d+),(-?%d+)$")
    -- `~= nil`, not truthiness: a debuff stores `false` and is still an outline.
    if x ~= nil and positions[string.format("%d,%d", tonumber(x), tonumber(y) + 1)] ~= nil then
      boxes = boxes + 1
    end
  end
  -- A client drawing each box as one quad leaves no corner to find. Reporting
  -- what was seen beats reporting zero while outlines are plainly on screen.
  if boxes == 0 then return total end
  return boxes
end

--- Icons given up on, with where they were and why. See the report site below.
---
--- DEDUPED BY ICON, NOT BY GIVING-UP. `onrendericon` pushes a fresh pending
--- entry every time the game DRAWS an icon, and the buff bar is redrawn on every
--- frame, so a single icon that never pairs is given up on once per frame and
--- fills all twelve slots by itself. That is exactly what happened: a panel
--- reading "twelve unpaired icons" was one icon, listed twelve times, and the
--- list could not have shown a second failing icon if there had been one. The
--- count is kept instead, since "given up on 54 times in a tick" and "once" mean
--- different things.
local unpaired, wipunpaired = {}, {}
local wipunpairedseen = {}
local MAX_UNPAIRED = 12

--- Positions already claimed by a buff found this tick, so one buff cannot be
--- published twice under two different ids.
---
--- Bolt splits a recognised item-model quad OUT of the batch to raise its icon
--- event, so in principle the icon path and the sprite path see disjoint sets
--- and this never fires. That is a claim about Bolt's internals rather than
--- something this file controls, and a duplicated buff would surface as two
--- picker entries that behave differently -- so it is guarded rather than
--- assumed.
local wipclaimed = {}

--- Whether an outline box was drawn at exactly this position this tick, and if
--- so whether it was a buff. nil when there was none.
local function outlineat(x, y)
  return wipoutlines[string.format("%d,%d", x, y)]
end

--- Sprite identity cache, keyed by atlas rectangle.
---
--- Atlas rects are packed at RUNTIME and are not stable between sessions, so a
--- rect cannot be the id -- but within one session a rect is a fixed sprite, so
--- it is a sound cache key. This is what keeps identity at one read per distinct
--- buff rather than sixty-four texture reads per buff per frame.
local spriteids = {}

--- Points sampled across an icon, per axis.
local SAMPLE_GRID = 8

--- Cap on identities reported to the UI. A bar holds well under this.
local MAX_IDENTITIES = 16

--- FNV-1a, 32-bit.
local FNV_OFFSET = 2166136261
local FNV_PRIME = 16777619

--- Stable identity for a sprite-drawn buff, or nil if its pixels cannot be read.
---
--- SAMPLED ON A RELATIVE GRID, NOT AT FIXED OFFSETS. Interface scale changes the
--- size a sprite is stored at, and fixed offsets would then read different parts
--- of the same picture. Relative points at least read CORRESPONDING parts.
---
--- QUANTISED TO THE TOP FOUR BITS per channel, so filtering noise -- a channel
--- off by one or two -- cannot change the id.
---
--- THIS IS THE PART OF THE DESIGN TAKEN ON TRUST rather than measured: whether
--- the atlas holds one variant per sprite or one per interface scale has not
--- been read out of a live draw stream. M.identities publishes the rect behind
--- each id so an id that moves when it should not is visible in the panel,
--- instead of being inferred later from an alert that quietly stopped firing.
local function spriteid(event, index)
  local ax, ay, aw, ah = event:vertexatlasdetails(index)
  if ax == nil or aw == nil or ah == nil or aw <= 0 or ah <= 0 then return nil end

  local rect = string.format("%d,%d,%d,%d", ax, ay, aw, ah)
  local cached = spriteids[rect]
  if cached ~= nil then return cached.id end

  local hash = FNV_OFFSET
  local read = 0
  for gy = 0, SAMPLE_GRID - 1 do
    for gx = 0, SAMPLE_GRID - 1 do
      local px = ax + math.floor((gx * aw) / SAMPLE_GRID)
      local py = ay + math.floor((gy * ah) / SAMPLE_GRID)
      local ok, texel = pcall(event.texturedata, event, px, py, 4)
      if ok and texel ~= nil and #texel >= 3 then
        read = read + 1
        for c = 1, 3 do
          local byte = string.byte(texel, c) // 16
          hash = (hash ~ byte) & 0xFFFFFFFF
          hash = (hash * FNV_PRIME) & 0xFFFFFFFF
        end
      end
    end
  end

  -- Nothing readable means no identity. Hashing zero samples would give every
  -- unreadable sprite the SAME id, which is worse than none: two unrelated buffs
  -- would collide and an alert would follow whichever drew last.
  if read == 0 then return nil end

  local id = string.format("s:%08x", hash)
  spriteids[rect] = { id = id, atlas = rect, w = aw, h = ah }
  return id
end

--- Open a new tick: publish what the last one gathered, then start clean.
---
--- Publishing here rather than in a separate reader is what makes the ordering
--- in main.lua safe. An earlier version cleared the lists in this function and
--- read them immediately afterwards in the same callback, so the bridge sent an
--- empty list on every tick no matter what detection had seen -- and, worse, the
--- diagnostic counters that were supposed to explain the empty list were zeroed
--- by the very same call.
function M.request()
  -- Numbered across BOTH lists before publishing, because buffs and debuffs
  -- share one bar and the picker's "third along" has to mean third on screen
  -- rather than third of its own kind.
  local ordered = {}
  for _, b in ipairs(wipbuffs) do ordered[#ordered + 1] = b end
  for _, b in ipairs(wipdebuffs) do ordered[#ordered + 1] = b end
  table.sort(ordered, function (a, b) return (a.x or 0) < (b.x or 0) end)
  for i, b in ipairs(ordered) do b.slot = i end

  buffs, debuffs = wipbuffs, wipdebuffs
  icons, parsed = wipicons, wipparsed
  attempts = wipattempts
  unpaired = wipunpaired
  outlines = wipoutlines
  outlinecount = countboxes(wipoutlines)

  -- Nothing read for several ticks running means the learned sizes are wrong --
  -- or the bar changed under us -- so forget them and let the next parse teach
  -- them again. An empty buff bar is the common case here and costs only the
  -- unfiltered scan it started with.
  if #wipbuffs == 0 and #wipdebuffs == 0 then
    idleticks = idleticks + 1
    if idleticks >= IDLE_TICKS_BEFORE_RELEARN then
      iconsizes = {}
      sizecount = 0
      idleticks = 0
    end
  else
    idleticks = 0
  end

  wipbuffs, wipdebuffs = {}, {}
  seen = {}
  wipicons, wipparsed, wipattempts = 0, 0, 0
  wipunpaired = {}
  wipunpairedseen = {}
  wipoutlines = {}
  wipclaimed = {}
  pending = {}
end

--- Every sprite id derived this session, with the atlas rect it came from.
---
--- THE HASH IS THE PART OF THIS DESIGN TAKEN ON TRUST. If the atlas holds a
--- separate variant per interface scale, an id changes when the user rescales and
--- every alert bound to it stops matching -- silently, because a buff that cannot
--- be found is indistinguishable from one that is not active. Publishing the rect
--- makes that visible in the panel at a glance instead.
function M.identities()
  local out = {}
  for _, entry in pairs(spriteids) do
    if #out >= MAX_IDENTITIES then break end
    out[#out + 1] = { id = entry.id, atlas = entry.atlas, w = entry.w, h = entry.h }
  end
  return out
end

--- Buffs read on the last tick. Empty is meaningful — it means none are active.
function M.read()
  return buffs, debuffs
end

--- Icon draws offered during the last tick, of any kind. See `icons`.
function M.iconcount()
  return icons
end

--- How many of those icons produced a readable buff or debuff.
function M.parsedcount()
  return parsed
end

--- Pairing attempts made on the last tick. See `attempts`.
function M.attemptcount()
  return attempts
end

--- Icons that were given up on last tick, with their positions.
function M.unpairedicons()
  return unpaired
end

--- Distinct buff outline boxes drawn last tick.
---
--- READ THIS AGAINST THE ICON COUNT ON THE BAR. Bolt raises onrendericon only for
--- images it recognised as a rendered 3D item model, so a buff whose icon is a
--- plain authored sprite produces no icon event at all and cannot be detected by
--- anything downstream of one. Every buff on the bar has an outline, so outlines
--- greater than icons is the size of that blind spot, measured rather than
--- guessed at.
function M.outlinecount()
  return outlinecount
end

--- 0..1 float colour to 0..255, matching how the vendored modules read colours.
local function byte255(c)
  if c == nil then return nil end
  return math.floor((c * 255.0) + 0.5)
end

--- Record every buff/debuff outline box in this batch.
local function scanoutlines(event)
  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    -- An outline is a flat fill, which the modules identify by a nil uv.
    if event:vertexuv(i) == nil then
      local x, y = event:vertexxy(i + 2)
      if x ~= nil and y ~= nil then
        local r, g, b = event:vertexcolour(i)
        local rr, gg, bb = byte255(r), byte255(g), byte255(b)
        for _, o in ipairs(OUTLINE) do
          if rr == o.r and gg == o.g and bb == o.b then
            wipoutlines[string.format("%d,%d", x, y)] = o.isbuff
            break
          end
        end
      end
    end
  end
end

--- An icon is about to be drawn. Remember what and where.
---
--- Returns the signature it derived, or nil, so the probe can report the same
--- reading this module acts on rather than deriving its own.
function M.onrendericon(event)
  local models = event:modelcount()
  if models < 1 then return nil end

  local ok, verts = pcall(event.modelvertexcount, event, 1)
  if not ok or verts == nil then return nil end

  wipicons = wipicons + 1

  local id = string.format("%d:%d", models, verts)
  local x, y, w, h = event:xywh()

  -- Reported to the probe either way: the diagnostic must show every icon the
  -- game drew, including the ones detection has learned to ignore.
  if plausible(w, h) then
    pending[#pending + 1] = { id = id, x = x or 0, y = y or 0, w = w or 0, h = h or 0, tries = 0 }
    if #pending > MAX_PENDING then table.remove(pending, 1) end
  end

  return id
end

--- The text drawn after an icon belongs to one of the icons just drawn.
---
--- Every icon still waiting gets an attempt, and an icon that does not match
--- stays for a few more. The module's contract is that details arrive on the
--- NEXT render2d, but a bar that draws its icons in a run and their text
--- afterwards puts several events between the two. `MAX_TRIES` is a bound on
--- work rather than a claim about the renderer: without it, every inventory icon
--- on screen would be retried against every batch for the rest of the tick.
--- @param scanning boolean|nil false while this frame's scan budget is spent.
---
--- ONLY THE OUTLINE SWEEP IS BUDGETED, not the pairing. The sweep touches every
--- image in the batch, which is the cost main.lua's budget exists to bound; the
--- outline of a buff that is on screen is redrawn on every frame, so a window
--- covering one whole frame sees all of them. Pairing stays unbudgeted, because
--- an icon's timer text genuinely can arrive at any point in the tick — that is
--- why buffs was exempted from the budget in the first place.
function M.onrender2d(event, scanning)
  if scanning ~= false then scanoutlines(event) end

  local waiting = pending
  pending = {}

  for _, icon in ipairs(waiting) do
    -- Already read this tick. The timer will have ticked down by a fraction of a
    -- second since, which is not worth a parse on every frame.
    if not seen[icon.id] then
      wipattempts = wipattempts + 1
      -- On failure the second return is pcall's error message, not a verdict.
      --
      -- Kept, but do not read much into it being empty: the module was executed
      -- against all of its refusal paths and every one of them returns false
      -- WITHOUT raising, including handlers[nil], which is a legal nil-key read
      -- rather than an error. A null here therefore eliminates nothing. The
      -- outline check below is what actually distinguishes the cases.
      local ok, valid, number, parens, isbuff =
        pcall(buffmodule.tryreadbuffdetails, buffmodule, event, 1, icon.x, icon.y)
      if not ok then icon.err = tostring(valid) end

      if ok and valid then
        seen[icon.id] = true
        wipparsed = wipparsed + 1

        -- A buff read at this size means this is the size buff icons are drawn
        -- at, so everything else can stop being carried around.
        local key = sizekey(icon.w, icon.h)
        if not iconsizes[key] and sizecount < MAX_SIZES then
          iconsizes[key] = true
          sizecount = sizecount + 1
        end

        wipclaimed[string.format("%d,%d", icon.x, icon.y)] = true

        local slot = { id = icon.id, timeLeft = number, stacks = parens, x = icon.x, source = "icon" }
        if isbuff then
          wipbuffs[#wipbuffs + 1] = slot
        else
          wipdebuffs[#wipdebuffs + 1] = slot
        end
      else
        icon.tries = icon.tries + 1
        local isbuff = wipoutlines[string.format("%d,%d", icon.x, icon.y)]

        if icon.tries < MAX_TRIES then
          pending[#pending + 1] = icon
        elseif isbuff ~= nil then
          -- THE TIMER IS UNREADABLE, THE BUFF IS NOT. An outline box of the right
          -- colour sits exactly where this icon was drawn, which is the module's
          -- own test for "this is a buff" — it just never got that far, because
          -- everything upstream of its outline check is about the text.
          --
          -- Published with no timeLeft rather than dropped. The wire keeps null
          -- distinct from a number, and src/alerters/buffs.ts turns that into
          -- "cannot see" rather than a confident "expired", so a buff that
          -- arrives this way can be watched for presence and cannot fire a false
          -- expiry. Dropping it instead meant it was missing from the picker
          -- entirely and could not be watched for anything.
          seen[icon.id] = true
          wipparsed = wipparsed + 1
          wipclaimed[string.format("%d,%d", icon.x, icon.y)] = true

          local slot = { id = icon.id, x = icon.x, source = "icon" }
          if isbuff then
            wipbuffs[#wipbuffs + 1] = slot
          else
            wipdebuffs[#wipdebuffs + 1] = slot
          end
        else
          -- Given up on. Reported so that "four icons on the bar, three read"
          -- says WHICH one was lost and where it was, rather than leaving the
          -- difference to be inferred from two counts.
          --
          -- Reaching here now means something sharper than it used to: no outline
          -- box was drawn at this icon's exact position all tick. So the icon's
          -- reported origin and its outline's origin disagree, which is a
          -- geometry problem, NOT a text one.
          if icon.err == nil then icon.err = "no outline box at this position" end
          local key = string.format("%s@%d,%d", tostring(icon.id), icon.x, icon.y)
          local already = wipunpairedseen[key]
          if already ~= nil then
            already.count = already.count + 1
            if already.err == nil then already.err = icon.err end
          elseif #wipunpaired < MAX_UNPAIRED then
            local entry = { id = icon.id, x = icon.x, y = icon.y, count = 1, err = icon.err }
            wipunpairedseen[key] = entry
            wipunpaired[#wipunpaired + 1] = entry
          end
        end
      end
    end
  end

  -- SPRITE-DRAWN BUFFS, WHICH RAISE NO ICON EVENT AND ARE OTHERWISE UNREACHABLE.
  --
  -- Everything above this line starts from `pending`, which is built from
  -- onrendericon and nothing else. Bolt raises that only for images it
  -- recognised as a rendered item model, so abilities, prayers and familiars
  -- produce no event at all and half a measured bar could never be reached
  -- however well the pairing worked.
  --
  -- This is the pattern modules/buffs/README.md documents and this file never
  -- used: offer the module an image from THIS batch, with the details index just
  -- past it.
  --
  -- THE FILTER IS THE MODULE'S OWN EQUALITY, ASKED EARLY. It validates a buff by
  -- finding an outline quad at precisely the icon's top-left
  -- (modules/buffs/buffs.lua:85). Asking that first, against the outline table
  -- the sweep above just filled, is what holds this to one parse attempt per
  -- buff on the bar rather than one per image per batch -- which was measured at
  -- 2,366 a frame and cost five to ten FPS.
  if scanning == false then return end

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    -- Textured only. An outline is itself a flat fill, and offering one to the
    -- module as though it were an icon would be asking it about its own marker.
    if event:vertexuv(i) ~= nil then
      local x, y = event:vertexxy(i + 2)
      if x ~= nil and y ~= nil then
        local key = string.format("%d,%d", x, y)
        if outlineat(x, y) ~= nil and not wipclaimed[key] then
          wipattempts = wipattempts + 1
          local ok, valid, number, parens, isbuff =
            pcall(buffmodule.tryreadbuffdetails, buffmodule, event, i + verticesperimage, x, y)

          if ok and valid then
            local id = spriteid(event, i)
            -- A sprite whose pixels cannot be read has no identity, and an
            -- alert cannot be bound to something unnameable. Counted as an
            -- attempt above either way, so the cost stays visible.
            if id ~= nil and not seen[id] then
              seen[id] = true
              wipclaimed[key] = true
              wipparsed = wipparsed + 1

              local slot = { id = id, timeLeft = number, stacks = parens, x = x, source = "sprite" }
              if isbuff then
                wipbuffs[#wipbuffs + 1] = slot
              else
                wipdebuffs[#wipdebuffs + 1] = slot
              end
            end
          end
        end
      end
    end
  end
end

return M
