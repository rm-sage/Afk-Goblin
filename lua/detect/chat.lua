-- Chat detection, wrapping the public-domain bolt-chatmodule.
--
-- REQUIRES MESSAGE TIMESTAMPS ENABLED IN GAME. The module finds messages by
-- their "[HH:MM:SS]" prefix; with timestamps off there is nothing to anchor to
-- and no chat is read at all. Surfaced to the UI rather than failing quietly --
-- see `available`.
--
-- EVERY open chat box is read, not just the first. AfkWarden reads one box and
-- silently ignores the rest, which is why an alert configured against a filtered
-- tab appears to work and then never fires. Reading them all costs one extra
-- module call per box per tick.

local chatmodule = require("modules.chat.chat")

local M = {}

--- Messages read since the last drain, oldest first, deduped.
local pending = {}

--- Texts already queued this drain, so a message shown in two boxes emits once.
local pendingseen = {}

--- Per-box state, keyed by the screen position of its speech-bubble anchor.
---
--- Each box needs its OWN `mostrecent`: the module reports messages newer than
--- the one handed to it, and boxes carry different (often filtered) histories.
--- Sharing one marker across boxes would make each box suppress the others'
--- messages, which reads exactly like the alert being broken.
local boxes = {}

--- Scan counter, used to retire boxes that have gone away.
local scan = 0

--- Boxes unseen for this many scans are forgotten, so closing a tab does not
--- leak an entry forever.
local FORGET_AFTER_SCANS = 20

--- Whether any box was readable on the most recent scan.
local readable = false

--- Whether every readable box was scrolled up.
local scrolled = false

--- True when a scan is wanted on the next render2d event.
local wanted = false

--- Set once per master tick rather than per frame: render2d fires many times a
--- frame and scanning all of them is pure waste.
function M.request()
  wanted = true
  scan = scan + 1
end

--- Hands over everything read since the last call, oldest first.
function M.drain()
  if #pending == 0 then return nil end
  local out = pending
  pending = {}
  pendingseen = {}
  return out
end

--- Whether chat could be read on the last scan.
function M.available()
  return readable and not scrolled
end

function M.scrolledup()
  return scrolled
end

--- Number of chat boxes currently being read. Surfaced so the UI can show it.
function M.boxcount()
  local n = 0
  for _ in pairs(boxes) do n = n + 1 end
  return n
end

local function record(text)
  if pendingseen[text] then return end
  pendingseen[text] = true
  pending[#pending + 1] = text
end

--- Feed a render2d event. Safe to call for every event; cheap when not wanted.
function M.onrender2d(event)
  if not wanted then return end

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  local foundany = false
  local allscrolled = true

  for i = 1, vertexcount, verticesperimage do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    -- The chat box is anchored by an 11x11 speech-bubble icon. bolt-alerts
    -- confirms it with a texturecompare against a hard-coded row of pixels; that
    -- constant is not derivable from the PNG this module ships (a 21x20
    -- documentation image, not the atlas entry), and copying it out of a GPL2
    -- project would licence-contaminate this one.
    --
    -- So size is a cheap filter and the MODULE decides: tryreadchat returns
    -- false for anything that is not actually chat. If this ever profiles badly,
    -- derive the pixel constant from a live client rather than copying it.
    if aw == 11 and ah == 11 then
      local px, py = event:vertexxy(i + 2)
      local key = string.format("%d,%d", px or 0, py or 0)

      local box = boxes[key]
      if box == nil then
        box = { mostrecent = nil }
        boxes[key] = box
      end

      local ischat, isscrolled = chatmodule:tryreadchat(
        event,
        i + verticesperimage,
        box.mostrecent,
        function (message)
          box.mostrecent = message
          -- Messages arrive with their timestamp attached. Strip it: alerters
          -- match on what was said, and a timestamp would never match.
          local _, _, stripped = string.find(message, "^%[%d%d:%d%d:%d%d%](.+)")
          if stripped then record(stripped) end
        end
      )

      if ischat then
        box.seen = scan
        foundany = true
        if not isscrolled then allscrolled = false end
      else
        -- Not a chat box after all; do not keep state for it.
        if box.mostrecent == nil then boxes[key] = nil end
      end
    end
  end

  if foundany then
    wanted = false
    readable = true
    scrolled = allscrolled

    -- Retire boxes that have not been seen for a while, so closing a tab or
    -- moving the interface does not leak entries.
    for key, box in pairs(boxes) do
      if box.seen ~= nil and scan - box.seen > FORGET_AFTER_SCANS then
        boxes[key] = nil
      end
    end
  end
end

return M
