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
-- module call per box per frame.
--
-- EVERY FRAME IS SCANNED, AND THERE IS NO SCAN WINDOW.
--
-- There used to be one: opened on the master tick, closed at the next
-- onswapbuffers, on the assumption that a swap ends a frame. Bolt raises that
-- event on every buffer swap the CLIENT makes, and the client is not obliged to
-- make exactly one per frame. With more than one, the window opened and closed
-- before a single render2d event arrived, so chat was never scanned at all --
-- while chat alerts kept firing from what had been read before the window
-- narrowed, which is what made it look as though the diagnostics were lying
-- rather than the reader.
--
-- So a scan now spans a whole tick, made of whole frames, and closes only when
-- the next tick asks for its results. The cost is the vertex loop below running
-- every frame rather than one frame in thirty-six; `events` is published so that
-- cost, and any future regression in it, stays visible.

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

--- Tick counter, used to retire boxes that have gone away.
local scan = 0

--- Boxes unseen for this many ticks are forgotten, so closing a tab does not
--- leak an entry forever.
local FORGET_AFTER_SCANS = 20

--- Whether any box has ever been readable, and whether the last tick to see one
--- found every box scrolled up.
local readable = false
local scrolled = false

--- Published diagnostics. See `M.diagnostics`.
local bubbles, confirmed, scrolledboxes, events, scanned = 0, 0, 0, 0, 0
local bubblesever, confirmedever = 0, 0
local lastlines = 0

--- Anchor candidates reported per tick, and the cap on them.
local anchors = {}
local MAX_ANCHORS = 8

--- The tick in progress.
---
--- `tickseen` is keyed by anchor position so a box drawn on all thirty-six
--- frames of a tick is counted once rather than thirty-six times.
local tickseen = {}
local sawbox, sawreadablebox = false, false
local wipevents, wipscanned = 0, 0

--- Close the tick in progress, publish what it found, and open the next.
---
--- Publishing here rather than in a separate reader is what keeps main.lua's
--- ordering safe: it calls this and then reads, so the reads return the tick
--- that just ended and never a half-filled one.
function M.request()
  scan = scan + 1

  bubbles, confirmed, scrolledboxes = 0, 0, 0
  anchors = {}
  for key, entry in pairs(tickseen) do
    bubbles = bubbles + 1
    if entry.ischat then
      confirmed = confirmed + 1
      if entry.scrolled then scrolledboxes = scrolledboxes + 1 end
    end
    -- Where each candidate was and what became of it. An 11x11 image is a loose
    -- filter, so a rejected one is usually not a chat box at all -- but if a box
    -- IS being missed, this is what says which one and where.
    if #anchors < MAX_ANCHORS then
      anchors[#anchors + 1] = {
        at = key,
        ischat = entry.ischat,
        scrolled = entry.scrolled,
        sprite = entry.sprite,
        event = entry.event,
      }
    end
  end
  if bubbles > bubblesever then bubblesever = bubbles end
  if confirmed > confirmedever then confirmedever = confirmed end
  events, scanned = wipevents, wipscanned

  -- Publish readability only if the tick actually saw a chat box. A tick that
  -- rendered none says nothing about it, and calling that "unreadable" would
  -- flicker the verdict every time chat happened not to draw.
  if sawbox then
    readable = true
    -- Any single readable box is enough. Requiring all of them would mean
    -- scrolling one box up to read history silenced every alert watching the
    -- others, which is both surprising and exactly the sort of silent failure
    -- this app exists to remove.
    scrolled = not sawreadablebox
  end

  tickseen = {}
  sawbox, sawreadablebox = false, false
  wipevents, wipscanned = 0, 0
end

--- What the last tick found. All counts, and the interesting readings are zeroes.
function M.diagnostics()
  return {
    bubbles = bubbles,
    confirmed = confirmed,
    scrolledBoxes = scrolledboxes,
    bubblesEver = bubblesever,
    confirmedEver = confirmedever,
    events = events,
    scanned = scanned,
    lines = lastlines,
    anchors = anchors,
  }
end

--- Hands over everything read since the last call, oldest first.
function M.drain()
  lastlines = #pending
  if #pending == 0 then return nil end
  local out = pending
  pending = {}
  pendingseen = {}
  return out
end

--- Whether chat is readable right now, ignoring boxes that are scrolled up.
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

--- Characters in a "[HH:MM:SS]" prefix. Their colours belong to the timestamp,
--- not to the message: every line carries a white bracket and timestamp blue, so
--- counting them would make a filter for either match every message on screen.
local TIMESTAMP_CHARS = 10

--- 0..1 float colour to 0..255, matching how the vendored modules read colours.
local function byte255(c)
  if c == nil then return 0 end
  return math.floor((c * 255.0) + 0.5)
end

--- Text colours of each message on screen, keyed by the text the module assembles.
---
--- WHY A SECOND PASS RATHER THAN A BETTER FIRST ONE. The vendored module reads
--- text and reports no colour at all, and its callback hands over a string with
--- no position, so there is nothing to correlate a colour to. Reimplementing its
--- message assembly to capture both at once would mean owning the hard part it
--- exists to provide -- timestamp grouping, ordering, the stop at the previously
--- seen message -- and any drift between our parse and its parse would show up as
--- chat alerts that quietly stop firing. So the module stays authoritative for
--- text, this reads colours, and the two are reconciled BY TEXT: exact match or
--- nothing. A message this pass fails to assemble identically gets no colours,
--- which the browser already treats as "unknown" and declines to filter on.
---
--- Grouping mirrors modules/chat/chat.lua:69-98 deliberately: same stride, same
--- consecutive-duplicate test, same "a timestamp at the first timestamp's x
--- starts a message". Both public helpers it needs are exported by the module, so
--- none of its private pixel constants are copied.
---
--- A GLYPH'S COLOUR IS AT `i + verticesperimage`. Font characters are drawn twice,
--- black drop-shadow then the same glyph in the intended colour, and the module
--- relies on exactly that offset at chat.lua:131 to spot a white '[' followed by
--- timestamp blue. The two copies sit within a pixel of each other with the same
--- atlas entry, so the duplicate test below collapses each pair onto the shadow.
local function readcolours(event, startindex)
  local vertexcount = event:vertexcount()
  local vpi = event:verticesperimage()

  local firstindex, timestampx, timestampy
  for i = startindex, vertexcount, vpi do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)
    local ok, isstamp = pcall(chatmodule.chatindexcouldbetimestamp, chatmodule, event, i, ax, ay, aw, ah)
    if ok and isstamp then
      local x, y = event:vertexxy(i + 2)
      if x ~= nil and y ~= nil then
        firstindex, timestampx, timestampy = i, x, y
        break
      end
    end
  end
  if firstindex == nil then return nil end

  local out = {}
  local msg, chars, colours, seencolour = "", 0, {}, {}
  local lastx, lasty, lastax, lastay

  local function flush()
    if #msg > 0 and #colours > 0 then out[msg] = colours end
    msg, chars, colours, seencolour = "", 0, {}, {}
  end

  for i = firstindex, vertexcount, vpi do
    local x, y = event:vertexxy(i + 2)
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    if x ~= nil and y ~= nil then
      local duplicate = lastx ~= nil
        and math.abs(x - lastx) < 2 and math.abs(y - lasty) < 2
        and ax == lastax and ay == lastay

      if not duplicate then
        lastx, lasty, lastax, lastay = x, y, ax, ay

        if x == timestampx then
          local ok, isstamp =
            pcall(chatmodule.chatindexcouldbetimestamp, chatmodule, event, i, ax, ay, aw, ah)
          if ok and isstamp then
            flush()
            timestampy = y
          end
        end

        if y >= timestampy then
          local ok, char = pcall(chatmodule.lookupchatcharacter, chatmodule, event, ax, ay, aw, ah)
          if ok and char ~= nil then
            msg = msg .. tostring(char)
            chars = chars + 1
            if chars > TIMESTAMP_CHARS then
              local r, g, b = event:vertexcolour(i + vpi)
              local rr, gg, bb = byte255(r), byte255(g), byte255(b)
              local key = string.format("%d,%d,%d", rr, gg, bb)
              if not seencolour[key] then
                seencolour[key] = true
                colours[#colours + 1] = { rr, gg, bb }
              end
            end
          end
        end
      end
    end
  end
  flush()

  return out
end

--- A line, with the colours it was drawn in. `colors` may be empty, which the
--- browser reads as "unknown" and declines to filter on.
local function record(text, colours)
  if pendingseen[text] then return end
  pendingseen[text] = true
  pending[#pending + 1] = { text = text, colors = colours or {} }
end

--- Feed a render2d event. Called for EVERY event, scanned or not.
---
--- `scanning` is the caller's budget decision, not this module's. The loop below
--- reads the atlas entry of every image in every batch -- around 3,300 per frame
--- in a live client -- so running it on every frame of every tick cost real FPS.
--- main.lua bounds it by elapsed time rather than by a frame count, because Bolt
--- provides no reliable frame boundary; see the note on onswapbuffers there.
---
--- The event is counted either way, so the diagnostics show work that was
--- declined rather than batches that went missing.
function M.onrender2d(event, scanning)
  wipevents = wipevents + 1
  if scanning == false then return end
  wipscanned = wipscanned + 1

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  local foundany = false

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

      local entry = tickseen[key]
      if entry == nil then
        entry = {
          ischat = false,
          scrolled = false,
          -- The atlas entry this anchor was drawn from, and which batch it
          -- arrived in. A quick-chat icon and a chat box's own anchor are both
          -- 11x11, but they need not be the same SPRITE, and boxes are one batch
          -- each -- so these are the two readings that could tell them apart.
          sprite = string.format("%d,%d", ax or 0, ay or 0),
          event = wipevents,
        }
        tickseen[key] = entry
      end

      local box = boxes[key]
      if box == nil then
        box = { mostrecent = nil, primed = false }
        boxes[key] = box
      end

      -- Colours are read at most ONCE per anchor per batch, and only when a
      -- message is actually being recorded. The pass is as expensive as the
      -- module's own read, and the overwhelmingly common case is a tick in which
      -- nobody said anything -- so paying for it lazily is the difference between
      -- a cost per message and a cost per frame.
      local colourmap = nil
      local function coloursfor(message)
        if colourmap == nil then
          local ok, map = pcall(readcolours, event, i + verticesperimage)
          colourmap = (ok and map) or {}
        end
        return colourmap[message]
      end

      local ischat, isscrolled = chatmodule:tryreadchat(
        event,
        i + verticesperimage,
        box.mostrecent,
        function (message)
          box.mostrecent = message

          -- A BOX'S FIRST READ EMITS NOTHING. The module reports every message
          -- it can see when given no marker, and those are messages that were
          -- already on screen -- history, not events. Emitting them fires alerts
          -- for things that happened before anyone was watching.
          --
          -- It is not a rare edge either. Boxes are keyed by the position of
          -- their anchor, and quick-chat icons are the same 11x11 sprite, sitting
          -- inline against player names and MOVING as the log scrolls. Every new
          -- position was a brand-new box replaying the whole visible log.
          if not box.primed then return end

          -- Messages arrive with their timestamp attached. Strip it: alerters
          -- match on what was said, and a timestamp would never match.
          local _, _, stripped = string.find(message, "^%[%d%d:%d%d:%d%d%](.+)")
          if stripped then record(stripped, coloursfor(message)) end
        end
      )

      if ischat then
        box.primed = true
        box.seen = scan
        foundany = true
        sawbox = true
        entry.ischat = true
        entry.scrolled = isscrolled == true
        if not isscrolled then sawreadablebox = true end
      else
        -- Not a chat box after all; do not keep state for it.
        if box.mostrecent == nil then boxes[key] = nil end
      end
    end
  end

  if foundany then
    -- Retire boxes that have not been seen for a while, so closing a tab or
    -- moving the interface does not leak entries.
    for key, box in pairs(boxes) do
      if box.seen ~= nil and scan - box.seen > FORGET_AFTER_SCANS then
        boxes[key] = nil
      end
    end
  end

  -- Whether this batch turned out to hold a chat box, so main.lua can keep the
  -- XP scan off it. Chat and XP drops are both drawn in the game's text font, and
  -- a chat line reading "+50" would otherwise be indistinguishable from an XP
  -- drop -- which would reset an inactivity timer and DELAY the alert it exists
  -- to fire. See lua/detect/xp.lua.
  return foundany
end

return M
