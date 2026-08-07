-- Chat detection, wrapping the public-domain bolt-chatmodule.
--
-- REQUIRES MESSAGE TIMESTAMPS ENABLED IN GAME. The module finds messages by
-- their "[HH:MM:SS]" prefix; with timestamps off there is nothing to anchor to
-- and no chat is read at all. This is surfaced to the UI rather than failing
-- quietly -- see `available`.

local chatmodule = require("modules.chat.chat")

local M = {}

--- Messages read since the last drain, oldest first.
local pending = {}

--- The most recent message handed to the module, so it only reports newer ones.
local mostrecent = nil

--- Whether chat was readable on the most recent attempt.
local readable = false

--- Set while the chat box is scrolled up, which makes new messages unreadable.
local scrolled = false

--- True when a scan is wanted on the next render2d event.
local wanted = false

--- Ask for one scan. Called once per master tick rather than per frame:
--- render2d fires many times a frame and scanning all of them is pure waste.
function M.request()
  wanted = true
end

--- Hands over everything read since the last call, oldest first.
function M.drain()
  if #pending == 0 then return nil end
  local out = pending
  pending = {}
  return out
end

--- Whether chat could be read on the last scan.
function M.available()
  return readable and not scrolled
end

function M.scrolledup()
  return scrolled
end

--- Feed a render2d event. Safe to call for every event; cheap when not wanted.
function M.onrender2d(event)
  if not wanted then return end

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    -- The chat box is anchored by an 11x11 speech-bubble icon. bolt-alerts
    -- confirms it with a texturecompare against a hard-coded row of pixels; that
    -- constant is not derivable from the PNG this module ships (which is a 21x20
    -- documentation image, not the atlas entry), and copying it out of a GPL2
    -- project would licence-contaminate this one.
    --
    -- So the size is used as a cheap filter and the MODULE is left to decide:
    -- tryreadchat returns false for anything that is not actually chat. The cost
    -- is a few extra calls per scan against a handful of 11x11 images, at 1.6Hz.
    -- If that ever shows up in a profile, the right fix is to derive the pixel
    -- constant from a live client, not to copy it.
    if aw == 11 and ah == 11 then
      local ischat, isscrolled = chatmodule:tryreadchat(
        event,
        i + verticesperimage,
        mostrecent,
        function (message)
          mostrecent = message
          -- Messages arrive with their timestamp attached. Strip it: alerters
          -- match on what was said, and a timestamp would never match.
          local _, _, stripped = string.find(message, "^%[%d%d:%d%d:%d%d%](.+)")
          if stripped then pending[#pending + 1] = stripped end
        end
      )

      if ischat then
        wanted = false
        readable = true
        scrolled = isscrolled and true or false
        return
      end
    end
  end
end

return M
