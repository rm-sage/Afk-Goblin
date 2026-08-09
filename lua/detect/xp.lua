-- XP drops, read as text.
--
-- WHAT REGISTRY.TS SAID THE BLOCKER WAS, AND WHY IT WAS NOT ONE. It recorded
-- xpcounter and bigxp as awaiting "identifying the XP-drop '+' glyph against a
-- live client". No live reading was needed: the vendored chat module already
-- carries '+', every digit, ',', '.', 'k' and 'm' in its font tables across all
-- seven sizes, because since the 2026-01-19 interface update most game text uses
-- the chat font. So an XP drop is readable with the same lookup chat uses.
--
-- TOTAL ONLY, DELIBERATELY, AND THE UI SAYS SO.
--
-- A drop is drawn as a skill ICON beside a number, and the number alone cannot
-- say which skill it belongs to. Attributing it would mean hashing the icon
-- sprite and having the user bind each hash to one of AfkWarden's three-letter
-- codes -- a picker, a training step, and a live reading to confirm where the
-- icons sit. Decided against for now, so everything here accumulates under
-- "tot". Three of the four xpcounter alerts in the reference config name a
-- specific skill and will report themselves unreadable rather than quietly
-- watching everything, which is the failure mode this project keeps removing.
--
-- ONLY THE DIFFERENCE MATTERS. src/bolt-io/game-state.ts folds these into a
-- running total whose absolute value is meaningless -- it starts at zero every
-- session -- and every alerter diffs successive readings. That is what makes
-- reading drops a valid substitute for Alt1's ability to read a skill's true
-- total off the XP counter.
--
-- A DROP LINGERS FOR SEVERAL TICKS, and that is a known, bounded inaccuracy.
-- The game draws a drop for a couple of seconds while it floats and fades, so it
-- is deduped by TEXT within a tick but counted again on the next one. The total
-- therefore over-counts. It cannot under-count, which is the direction that
-- matters: an inactivity alert fires when XP STOPS, so a stale reading delays it
-- by roughly the drop's on-screen lifetime rather than suppressing it. Two
-- genuine identical drops in one tick collapse to one, which is invisible to
-- every alerter here because all of them only ask whether the total moved.

local chatmodule = require("modules.chat.chat")

local M = {}

--- Characters an XP drop may contain after its leading '+'.
---
--- STRICT ON PURPOSE. This is the second guard against reading ordinary text as
--- a drop: the first is that main.lua does not offer this batches that held a
--- chat box. A run containing anything else -- a letter, a colon -- is not a
--- drop, and rejecting it costs nothing because a real drop never does.
local ALLOWED = {
  ["0"] = true, ["1"] = true, ["2"] = true, ["3"] = true, ["4"] = true,
  ["5"] = true, ["6"] = true, ["7"] = true, ["8"] = true, ["9"] = true,
  [","] = true, ["."] = true, ["k"] = true, ["m"] = true,
}

--- Multipliers a drop's suffix can carry.
local MULTIPLIER = { k = 1000, m = 1000000 }

--- Largest horizontal gap between two glyphs still counted as one run, in pixels.
---
--- Generous because it must hold at every interface scale, and tight enough that
--- two separate drops side by side do not merge. A space inside a drop does not
--- arise -- the format is '+' then digits -- so this only has to span the natural
--- advance between adjacent characters.
local MAX_GLYPH_GAP = 14

--- Runs published on the tick, and the tick in progress.
local drops, wipdrops = {}, {}
local wipseen = {}

--- Diagnostics: text runs examined, and how many parsed as a drop.
local examined, parsed = 0, 0
local wipexamined, wipparsed = 0, 0

--- Publish what the tick gathered, then start clean.
---
--- Same shape as the other detectors, and for the same reason: main.lua calls
--- request and then reads in one callback, so anything reset in place without
--- publishing first reads back empty.
function M.request()
  drops = wipdrops
  examined, parsed = wipexamined, wipparsed
  wipdrops = {}
  wipseen = {}
  wipexamined, wipparsed = 0, 0
end

--- Amounts read on the last tick, one entry per distinct drop text.
function M.read()
  return drops
end

--- Text runs examined and how many parsed, for the detection panel.
function M.diagnostics()
  return { examined = examined, parsed = parsed }
end

--- Turn "+1,234" or "+1.5k" into a number, or nil if it is not a drop.
local function parseamount(text)
  local body = string.match(text, "^%+(.+)$")
  if body == nil then return nil end

  local multiplier = 1
  local suffix = string.sub(body, -1)
  if MULTIPLIER[suffix] ~= nil then
    multiplier = MULTIPLIER[suffix]
    body = string.sub(body, 1, -2)
  end

  -- Thousands separators are presentation; the decimal point is not.
  body = string.gsub(body, ",", "")
  if body == "" then return nil end
  if string.match(body, "^%d+%.?%d*$") == nil then return nil end

  local n = tonumber(body)
  if n == nil then return nil end
  return math.floor((n * multiplier) + 0.5)
end

--- Close a run and keep it if it reads as a drop.
local function finish(text)
  if text == nil or #text < 2 then return end
  wipexamined = wipexamined + 1

  local amount = parseamount(text)
  if amount == nil or amount <= 0 then return end

  -- Deduped by text: the same drop is redrawn on every frame of the tick, and
  -- counting each sighting would multiply it by the frame rate.
  if wipseen[text] then return end
  wipseen[text] = true
  wipparsed = wipparsed + 1
  wipdrops[#wipdrops + 1] = amount
end

--- Feed a render2d batch.
--- @param scanning boolean|nil false once this frame's scan budget is spent.
--- @param ischatbatch boolean|nil true when chat detection claimed this batch.
---
--- The font-size table is the cheap filter that makes this affordable: a glyph
--- lookup reads pixels, and `chatchars` is keyed by atlas height, so anything
--- that is not drawn at a known font size is rejected by one table index rather
--- than by a texture read.
function M.onrender2d(event, scanning, ischatbatch)
  if scanning == false or ischatbatch == true then return end

  local vertexcount = event:vertexcount()
  local vpi = event:verticesperimage()

  local run = nil
  local lastx, lasty, lastax, lastay

  for i = 1, vertexcount, vpi do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    if ah ~= nil and chatmodule.chatchars[ah] ~= nil then
      local x, y = event:vertexxy(i + 2)
      if x ~= nil and y ~= nil then
        local duplicate = lastx ~= nil
          and math.abs(x - lastx) < 2 and math.abs(y - lasty) < 2
          and ax == lastax and ay == lastay

        if not duplicate then
          local ok, char = pcall(chatmodule.lookupchatcharacter, chatmodule, event, ax, ay, aw, ah)
          char = ok and char or nil

          if char ~= nil then
            local continues = run ~= nil
              and lasty ~= nil and math.abs(y - lasty) < 2
              and x >= lastx and (x - lastx) <= MAX_GLYPH_GAP

            if continues and ALLOWED[tostring(char)] then
              run = run .. tostring(char)
            else
              finish(run)
              -- Only a '+' can open a run, which is what keeps this from walking
              -- every number on screen.
              run = (tostring(char) == "+") and "+" or nil
            end

            lastx, lasty, lastax, lastay = x, y, ax, ay
          end
        end
      end
    end
  end

  finish(run)
end

return M
