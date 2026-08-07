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

local buffmodule = require("modules.buffs.buffs")

local M = {}

--- Signature and screen position of the icon seen in the most recent
--- onrendericon, waiting for the render2d that carries its text.
local pending = nil
local pendingx, pendingy = 0, 0

--- Buffs and debuffs collected during the current scan.
local buffs, debuffs = {}, {}

--- Whether anything was read on the last completed scan.
local seenany = false

local wanted = false

function M.request()
  -- A fresh scan starts a fresh list: a buff that has expired must DISAPPEAR,
  -- and carrying the previous tick's entries would keep it alive forever.
  buffs, debuffs = {}, {}
  seenany = false
  wanted = true
end

--- Buffs read on the last scan. Empty is meaningful — it means none are active.
function M.read()
  return buffs, debuffs
end

function M.sawany()
  return seenany
end

--- An icon is about to be drawn. Remember what and where.
function M.onrendericon(event)
  if not wanted then return end

  local models = event:modelcount()
  if models < 1 then return end

  local ok, verts = pcall(event.modelvertexcount, event, 1)
  if not ok or verts == nil then return end

  pending = string.format("%d:%d", models, verts)
  local x, y = event:xywh()
  pendingx, pendingy = x or 0, y or 0
end

--- The text drawn immediately after an icon belongs to that icon.
function M.onrender2d(event)
  if not wanted or pending == nil then return end

  local signature = pending
  pending = nil

  local ok, valid, number, parens, isbuff =
    pcall(buffmodule.tryreadbuffdetails, buffmodule, event, 1, pendingx, pendingy)
  if not ok or not valid then return end

  local slot = { id = signature, timeLeft = number, stacks = parens }
  if isbuff then
    buffs[#buffs + 1] = slot
  else
    debuffs[#debuffs + 1] = slot
  end
  seenany = true
end

return M
