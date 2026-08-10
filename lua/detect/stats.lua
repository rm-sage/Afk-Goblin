-- Action bar resource levels: health, adrenaline, prayer and summoning.
--
-- Each bar is drawn as a 106x4 atlas image. bolt-alerts identifies which is
-- which by matching the ENTIRE 106-pixel top row against a lookup table; that
-- table is several kilobytes of hard-coded pixel data in a GPL2 project, so it
-- is not copied here.
--
-- Instead the bar is identified by its COLOUR, which is a fact about the game's
-- palette rather than anything authored, and the check is a few lines instead of
-- a few kilobytes. Being looser is not a correctness risk: only four images in
-- the game are 106x4 and they are four clearly different colours.
--
-- MEASURED FROM A LIVE DRAW STREAM ON 2026-08-07, and the reading is quoted in
-- full beside HUES below. Two things it settled, both of which had been written
-- here as confident statements that were wrong:
--
--   * The size is right. Exactly four 106x4 images are drawn per frame.
--   * The TEXTURE carries the colour and the vertex tint is plain white. A
--     previous session concluded the exact opposite -- that the four bars shared
--     one neutral sprite tinted per bar -- and wrote it into this header, the
--     tests and the fake host. Nothing in the draw stream ever supported it.
--
-- WHY HUE AND NOT RGB. Matching each bar against a hard-coded RGB triple within
-- a tolerance of 12 identified NONE of the four for an entire session. The
-- guessed triples were off by up to 31 in a single channel -- every one of them
-- darker than what is really drawn, which is what sampling one row of a shaded
-- 4px bar gets you. But their HUES were within 5 degrees of correct. Hue is
-- exactly the component that survives the shading, gradient and interface-scale
-- differences that broke the RGB match, and the four bars are 37 degrees apart
-- at their closest, so it has room to spare. A brightness-invariant match is the
-- fix; a fresh set of RGB triples would only have been the same guess again.
--
-- STILL NOT CONFIRMED: the fill geometry. Every bar in that reading was drawn at
-- 90px, so this file cannot yet tell "the bar is stretched to its value" from
-- "the bar is a fixed-width frame and the value lives somewhere else". If a bar
-- reads as a wrong fraction rather than as nil, FILL_W and the vertex order are
-- what to check -- against a reading taken at a known, NOT-full value.

local M = {}

local BAR_W = 106
local BAR_H = 4

--- Pixel column sampled to identify a bar. Past the rounded left cap, well
--- inside the filled region even at low values.
local SAMPLE_X = 8
local SAMPLE_Y = 1

--- Width in pixels of a completely full bar, excluding its end caps.
local FILL_W = 89.0

--- Hue of each bar in degrees, measured at SAMPLE_X, SAMPLE_Y from the live
--- draw stream. The reading these came from, verbatim:
---
---   bar 106x4 at 1488,1119 drawn 90px  texture #f87650  tint #ffffff
---   bar 106x4 at 1614,1119 drawn 90px  texture #edcd1f  tint #ffffff
---   bar 106x4 at 1740,1119 drawn 90px  texture #8261b5  tint #ffffff
---   bar 106x4 at 1866,1119 drawn 90px  texture #1faca0  tint #ffffff
---
--- Left to right at a fixed 126px spacing, which is the order the action bar
--- draws them in: health, adrenaline, prayer, summoning.
local HUES = {
  { key = "hp", hue = 14 },
  { key = "dren", hue = 51 },
  { key = "pray", hue = 264 },
  { key = "sum", hue = 175 },
}

--- Degrees a hue may be out and still count. The two closest bars are 37 degrees
--- apart (health at 14, adrenaline at 51), so 15 leaves a 7 degree gap between
--- neighbouring bands and still absorbs three times the error the old guesses had.
local HUE_TOLERANCE = 15

--- How colourful something must be before its hue means anything at all.
---
--- THIS IS WHAT KEEPS WHITE OFF THE HEALTH BAR. Hue is undefined for greys, and
--- the naive conversion hands back 0 degrees for them -- which is 14 degrees from
--- health and would match. The vertex tint on every bar in the reading above is
--- plain #ffffff, and `identify` falls back to reading it, so without this gate
--- the fallback would report a full health bar for literally any white quad on
--- screen. The least colourful bar of the four (prayer) sits at 0.46, so 0.30
--- clears them all with margin while greys sit at 0.00.
local MIN_SATURATION = 0.30

--- How bright it must be. A bar rendered nearly black is a hidden interface, not
--- a reading. The dimmest of the four is prayer at 0.71.
local MIN_VALUE = 0.25

--- Bars read during the tick in progress. Cleared every tick, so a reading cannot
--- outlive the thing it read.
local levels = {}

--- What the tick that just ended actually read, keyed by bar. Only these are
--- published; a bar absent here is absent on the wire and decodes as null.
local published = {}

--- Set while this tick still has bars left to find.
---
--- A TICK, not a scan window closed by the next onswapbuffers. Bolt raises that
--- event on every buffer swap the client makes and the client may make several
--- per frame, so a window closed on the next swap can close before any render2d
--- arrives -- and then no bar is ever read. Same trap that made chat report
--- itself blind; see the header of lua/detect/chat.lua.
local wanted = false

--- Bars read during the tick in progress, and how many.
---
--- Scanning stops once all four have been read, NOT once the first has. Each bar
--- can be drawn in its own render2d batch, and stopping on the first one meant
--- every bar in a later batch was never read at all -- it kept the safe default
--- below forever, so a prayer alert would sit silent while prayer drained.
--- Counting is what lets the common case (all four in one batch) still stop
--- immediately.
local seen = {}
local seencount = 0

--- What the tick that just ended managed to read.
---
--- Published on request rather than read live, for the same reason buffs
--- publishes its lists there: main.lua calls request and then reads in the same
--- callback, so a counter reset in place always reads back as zero.
local lastseencount = 0

function M.request()
  wanted = true
  lastseencount = seencount
  published = {}
  for key in pairs(seen) do published[key] = levels[key] end
  seen = {}
  seencount = 0
  -- CLEARED, so a reading cannot outlive the thing it read. `levels` used to
  -- persist for the whole session, so the last-known fractions kept being
  -- published as current the moment the action bar went off screen -- a cutscene,
  -- a full-screen interface, a hidden HUD.
  levels = {}
end

--- How many of the four bars were read on the last tick. Diagnostic: a
--- persistent zero means the action bar is not being seen at all.
function M.seencount()
  return lastseencount
end

--- The levels read on the last tick, or nil when none were.
---
--- ONLY THE BARS ACTUALLY SEEN, and substituting a plausible value for the rest
--- was a silent missed alert. This used to fill unread bars with `hp = 1.0` and
--- `dren = 0.0`, so on a client where the health bar's hue never cleared the
--- saturation gate while another bar did, it reported full health from the first
--- tick onward -- for the whole session, with `functional: true`. An "HP at or
--- below 25%" alert could never fire and never said why, while barsRead quietly
--- read 1.
---
--- That is the same defect the XP reader was rewritten to remove: once one reading
--- had been taken, "cannot see it" stopped being representable. A missing key
--- reaches the schema absent and decodes as null, which the alerter turns into no
--- data for that specific stat.
function M.read()
  local any = false
  for _ in pairs(published) do any = true break end
  if not any then return nil end

  return {
    hp = published.hp,
    pray = published.pray,
    sum = published.sum,
    dren = published.dren,
  }
end

--- 0..255 RGB to hue in degrees, saturation and value in 0..1.
local function hsv(r, g, b)
  local mx = math.max(r, g, b)
  local mn = math.min(r, g, b)
  local d = mx - mn

  if mx == 0 then return 0.0, 0.0, 0.0 end
  local s = d / mx
  local v = mx / 255.0
  if d == 0 then return 0.0, s, v end

  local h
  if mx == r then
    -- Lua's % takes the sign of the divisor, so a negative sixth wraps to the
    -- top of the wheel rather than going negative. That is the behaviour wanted
    -- here: red sits either side of zero.
    h = ((g - b) / d) % 6
  elseif mx == g then
    h = ((b - r) / d) + 2
  else
    h = ((r - g) / d) + 4
  end

  return h * 60.0, s, v
end

--- Degrees between two hues, the short way round the wheel.
---
--- Red is the case that makes this necessary: health sits at 14 degrees and a
--- slightly redder sample reads as 358, which is 8 degrees away and would
--- subtract to 344.
local function huegap(a, b)
  local d = math.abs(a - b) % 360.0
  if d > 180.0 then d = 360.0 - d end
  return d
end

--- Which bar, if any, is this colour?
local function match(r, g, b)
  if r == nil then return nil end

  local h, s, v = hsv(r, g, b)
  if s < MIN_SATURATION or v < MIN_VALUE then return nil end

  for _, c in ipairs(HUES) do
    if huegap(h, c.hue) <= HUE_TOLERANCE then return c.key end
  end
  return nil
end

--- 0..1 float colour to 0..255, matching how the vendored modules read colours.
local function byte255(c)
  if c == nil then return nil end
  return math.floor((c * 255.0) + 0.5)
end

--- Which of the four bars this image is, or nil.
---
--- TWO SOURCES OF COLOUR, because a sprite's pixels are not necessarily its
--- colour: a shared sprite tinted per use carries its colour in the vertex
--- instead. Which of the two applies here was guessed at once and guessed wrong,
--- so it is now recorded from a measurement: the TEXTURE carries the colour and
--- the tint is plain #ffffff. Texture first is therefore the live path, and the
--- vertex fallback is kept only for a client that does it the other way.
---
--- The fallback is safe precisely BECAUSE the tint here is white: `match` throws
--- out anything below MIN_SATURATION, so a white tint identifies nothing rather
--- than identifying whichever bar happens to sit nearest hue zero.
local function identify(event, ax, ay, index)
  local px = event:texturedata(ax + SAMPLE_X, ay + SAMPLE_Y, 4)
  if px ~= nil and #px >= 3 then
    local key = match(string.byte(px, 1, 3))
    if key ~= nil then return key end
  end

  local r, g, b = event:vertexcolour(index)
  return match(byte255(r), byte255(g), byte255(b))
end

function M.onrender2d(event, scanning)
  if not wanted or scanning == false then return end

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    if aw == BAR_W and ah == BAR_H then
      local key = identify(event, ax, ay, i)
      if key ~= nil then
        -- The bar is stretched to its fill level, so the drawn width IS the
        -- value. Read it from the vertex positions rather than the texture.
        local right = event:vertexxy(i)
        local left = event:vertexxy(i + 2)
        if right ~= nil and left ~= nil then
          local fraction = (right - (left + 1)) / FILL_W
          if fraction < 0.0 then fraction = 0.0 end
          if fraction > 1.0 then fraction = 1.0 end
          levels[key] = fraction

          if not seen[key] then
            seen[key] = true
            seencount = seencount + 1
            if seencount >= #HUES then wanted = false end
          end
        end
      end
    end
  end
end

return M
