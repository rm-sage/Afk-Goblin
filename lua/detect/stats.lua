-- Action bar resource levels: health, adrenaline, prayer and summoning.
--
-- Each bar is drawn as a 106x4 atlas image. bolt-alerts identifies which is
-- which by matching the ENTIRE 106-pixel top row against a lookup table; that
-- table is several kilobytes of hard-coded pixel data in a GPL2 project, so it
-- is not copied here.
--
-- Instead one pixel is sampled and matched against each bar's dominant colour.
-- Those RGB values are facts about the game's palette rather than anything
-- authored, the check is a few lines instead of a few kilobytes, and being
-- looser is not a correctness risk: only four images in the game are 106x4 and
-- they are four clearly different colours.
--
-- NOT YET VERIFIED AGAINST A LIVE CLIENT. The sample offset and the fill
-- geometry below are taken from observation of how these bars are drawn; if a
-- bar reads as nil or as a wrong fraction in game, this is the file to check.

local M = {}

local BAR_W = 106
local BAR_H = 4

--- Pixel column sampled to identify a bar. Past the rounded left cap, well
--- inside the filled region even at low values.
local SAMPLE_X = 8
local SAMPLE_Y = 1

--- Width in pixels of a completely full bar, excluding its end caps.
local FILL_W = 89.0

--- Dominant colour of each bar, as {r, g, b}.
local COLOURS = {
  { key = "hp", r = 0xf3, g = 0x57, b = 0x37 },
  { key = "dren", r = 0xe3, g = 0xb6, b = 0x21 },
  { key = "pray", r = 0x74, g = 0x51, b = 0xab },
  { key = "sum", r = 0x18, g = 0x9e, b = 0x8f },
}

--- Per-channel tolerance. The bars are flat-shaded, so anything beyond a few
--- units is a different image rather than a shading difference.
local TOLERANCE = 12

--- Latest reading per bar, or nil when never seen.
local levels = {}

--- Set while a scan is wanted.
local wanted = false

function M.request()
  wanted = true
end

--- The current levels, or nil if no bar has ever been read.
---
--- Returns nil rather than zeroes when unread: a caller must be able to tell
--- "cannot see the action bar" from "you are about to die".
function M.read()
  if levels.hp == nil and levels.pray == nil and levels.dren == nil and levels.sum == nil then
    return nil
  end
  return {
    hp = levels.hp or 1.0,
    pray = levels.pray or 1.0,
    sum = levels.sum or 1.0,
    dren = levels.dren or 0.0,
  }
end

local function identify(event, ax, ay)
  local px = event:texturedata(ax + SAMPLE_X, ay + SAMPLE_Y, 4)
  if px == nil or #px < 3 then return nil end

  local r, g, b = string.byte(px, 1, 3)
  for _, c in ipairs(COLOURS) do
    if math.abs(r - c.r) <= TOLERANCE
      and math.abs(g - c.g) <= TOLERANCE
      and math.abs(b - c.b) <= TOLERANCE then
      return c.key
    end
  end
  return nil
end

function M.onrender2d(event)
  if not wanted then return end

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    if aw == BAR_W and ah == BAR_H then
      local key = identify(event, ax, ay)
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
          wanted = false
        end
      end
    end
  end
end

return M
