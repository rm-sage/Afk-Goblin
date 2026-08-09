-- What is actually in the draw stream, sampled on demand.
--
-- WHY THIS EXISTS. Every detector here identifies its target by a constant
-- someone guessed at: chat by an 11x11 anchor, the action bar by a 106x4 image
-- in one of four colours, buffs by an icon event carrying a model. When one of
-- those guesses is wrong the reading is not wrong, it is ABSENT, and an absent
-- reading looks exactly like an empty screen. Three sessions were spent
-- guessing again at constants that were never checked.
--
-- So this reports what the game draws rather than what we hoped it draws: the
-- shapes and colours present, and where the icons are. A wrong constant then
-- shows up as "there is no 106x4 image, but there is an 89x4 flat quad in that
-- colour", which is an answer rather than another guess.
--
-- ARMED ON DEMAND, NEVER LEFT ON. Sampling means a string key per image per
-- frame, which is far too much to run continuously. The UI arms it, one tick is
-- sampled, the report goes back, and it disarms itself.

local textscan = require("lua.detect.text")

local M = {}

--- Distinct shape keys kept. Enough to cover an interface, small enough that the
--- report stays a message rather than a transfer.
---
--- A live reading filled this exactly, and a full table drops silently at `note`
--- — so every shape first drawn after the 64th was absent from a report that
--- read as complete. Whatever is missing that way is the least common shape on
--- screen, which is the description of the thing being looked for.
local MAX_SHAPES = 160

--- Icon draws kept. A buff bar holds well under this; the cap is there so an
--- inventory full of items cannot turn the report into a flood.
---
--- Kept per FRAME rather than in total: a report of four identical frames wastes
--- the whole budget saying the same thing four times, and what is actually
--- wanted is one complete frame.
local MAX_ICONS = 96

--- Bar-shaped images reported in full.
---
--- NOT "four expected plus slack", WHICH IS WHAT THIS SAID AND IT NEARLY COST
--- THE READING. The filter admits anything at least 60 wide and at most 6 tall,
--- and a live interface draws far more than the action bar at that shape: one
--- reading held ten 112x2 panel rules and four 112x4 borders alongside the four
--- 106x4 bars, eighteen distinct positions for twelve slots. It filled to
--- exactly twelve and the four that mattered survived only because they happened
--- to be drawn early. Sized to hold a whole interface instead.
local MAX_BARS = 48

--- Text runs reported. An interface holds well under this; the cap is there so a
--- screen full of chat cannot turn the report into a flood.
local MAX_TEXT = 64

local armed = false
local ticks = 0

--- key -> count, where the key describes one shape as drawn.
local shapes = {}
local shapecount = 0

--- Icon draws, in the order the game made them.
local icons = {}

--- Wide, thin images, reported with their colours. See `M.onrender2d`.
---
--- Deduped by position, like the icons: four bars drawn over three frames is
--- twelve entries saying the same thing three times, and the budget is better
--- spent on four distinct ones.
local bars = {}
local barseen = {}

--- Icons already reported, so a tick's worth of identical frames is not four
--- copies of the same list. The budget is far better spent on one complete frame
--- than on the same twenty-four icons repeated until it runs out.
local iconseen = {}

--- Text runs found, with where they were. See `M.text`.
---
--- SHAPES AND COLOURS WERE NOT ENOUGH. The reason this section exists is the XP
--- counter: reading it needs to know the header strings, the column order, the row
--- pitch, the number format and whether the panel is one batch — and every one of
--- those was about to be guessed at, which is the failure this whole file was
--- built to prevent. A dump of the text actually drawn answers all of them at
--- once, and answers them for the next interface too.
local texts = {}
local textseen = {}

--- Start sampling. The next full tick is what gets reported.
function M.arm()
  armed = true
  ticks = 0
  shapes = {}
  shapecount = 0
  icons = {}
  iconseen = {}
  bars = {}
  barseen = {}
  texts = {}
  textseen = {}
end

function M.armed()
  return armed
end

--- Count one shape, and remember where it was first drawn.
---
--- The position is what turns a size into a location. "There are six 27x27
--- images at y=990" is the answer to "is half the buff bar drawn as flat sprites
--- rather than as icons?", and a bare count cannot say it.
local function note(key, x, y)
  local existing = shapes[key]
  if existing ~= nil then
    existing.count = existing.count + 1
  elseif shapecount < MAX_SHAPES then
    shapes[key] = { count = 1, x = x or 0, y = y or 0 }
    shapecount = shapecount + 1
  end
end

--- 0..1 float colour to 0..255, matching how the vendored modules read colours.
local function byte255(c)
  if c == nil then return 0 end
  return math.floor((c * 255.0) + 0.5)
end

function M.onrendericon(event, id)
  if not armed then return end
  if #icons >= MAX_ICONS then return end

  local x, y, w, h = event:xywh()
  local key = string.format("%s@%d,%d", tostring(id), x or 0, y or 0)
  if iconseen[key] then return end
  iconseen[key] = true

  icons[#icons + 1] = { id = id, x = x or 0, y = y or 0, w = w or 0, h = h or 0 }
end

--- Summarise every image in one batch.
---
--- Textured images are keyed by their ATLAS size, because that is what chat and
--- the action bar match on. Untextured ones are flat colour fills — the buff
--- module's own reader tells them apart by a nil uv — and are keyed by their
--- DRAWN size and colour, because a flat fill has no atlas entry to match at all.
--- If the resource bars turn out to be flat fills, that is the whole reason the
--- action bar reads as invisible.
function M.onrender2d(event)
  if not armed then return end

  -- Every text run drawn, with where it was. Deduped by text and position so a
  -- tick of identical frames reports one copy.
  textscan.scan(event, function (run, box)
    local key = string.format("%s@%d,%d", run, box.left, box.bottom)
    if textseen[key] or #texts >= MAX_TEXT then return end
    textseen[key] = true
    texts[#texts + 1] = {
      text = run,
      x = box.left,
      y = box.bottom,
      w = box.right - box.left,
      h = box.bottom - box.top,
    }
  end)

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    local u = event:vertexuv(i)
    local x1, y1 = event:vertexxy(i)
    local x2, y2 = event:vertexxy(i + 2)
    local w = math.abs((x1 or 0) - (x2 or 0))
    local h = math.abs((y1 or 0) - (y2 or 0))

    if u == nil then
      local r, g, b = event:vertexcolour(i)
      note(string.format("flat %dx%d #%02x%02x%02x", w, h, byte255(r), byte255(g), byte255(b)),
        x2, y2)
    else
      local ax, ay, aw, ah = event:vertexatlasdetails(i)
      note(string.format("image %dx%d", aw or 0, ah or 0), x2, y2)

      -- A BAR-SHAPED IMAGE GETS READ IN FULL. The action bar's four resource
      -- bars are wide and a few pixels tall, and they are the one thing here
      -- still reading as invisible while sitting plainly in the draw stream.
      -- Reporting their actual colours -- from the texture AND from the vertex
      -- tint, because those disagree when a sprite is shared and tinted -- turns
      -- "the palette is wrong somewhere" into a value that can be read off. The
      -- drawn width comes too, since it is what the fill fraction is computed
      -- from.
      local barkey = string.format("%dx%d@%d,%d", aw or 0, ah or 0, x2 or 0, y2 or 0)
      if (aw or 0) >= 60 and (ah or 0) <= 6 and not barseen[barkey] and #bars < MAX_BARS then
        barseen[barkey] = true
        local texel = event:texturedata((ax or 0) + 8, (ay or 0) + 1, 4)
        local tr, tg, tb = event:vertexcolour(i)
        bars[#bars + 1] = {
          atlas = string.format("%dx%d", aw or 0, ah or 0),
          x = x2 or 0,
          y = y2 or 0,
          drawn = w,
          texture = texel ~= nil and #texel >= 3
            and string.format("#%02x%02x%02x", string.byte(texel, 1, 3))
            or "unreadable",
          tint = string.format("#%02x%02x%02x", byte255(tr), byte255(tg), byte255(tb)),
        }
      end
    end
  end
end

--- Called once per master tick. Returns a report when one has been sampled.
function M.tick()
  if not armed then return nil end

  -- Arming happens mid-tick, so the first boundary reached has only a partial
  -- tick behind it. Report at the second, which has a whole one.
  ticks = ticks + 1
  if ticks < 2 then return nil end

  armed = false

  local list = {}
  for key, entry in pairs(shapes) do
    list[#list + 1] = { key = key, count = entry.count, x = entry.x, y = entry.y }
  end
  table.sort(list, function (a, b) return a.count > b.count end)

  return {
    t = "probe",
    shapes = list,
    icons = icons,
    bars = bars,
    texts = texts,
    -- `bars` counts too. It was left out, so a bar list that had silently
    -- dropped the action bar reported itself as a complete reading.
    truncated = shapecount >= MAX_SHAPES or #icons >= MAX_ICONS or #bars >= MAX_BARS
      or #texts >= MAX_TEXT,
  }
end

return M
