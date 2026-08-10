-- XP, read off the XP counter interface.
--
-- WHY NOT THE FLOATING "+N" DROPS, which this file used to read. A drop is
-- redrawn while it floats and fades, so it is counted again on every tick until it
-- vanishes -- measured in game at about five seconds of tail after XP really
-- stops. An inactivity alert therefore fired five seconds late, which the user
-- reported as killing the feature for anything time-sensitive. Deduping a drop
-- across ticks is not available as a fix: two genuine identical drops ("+54"
-- twice while training steadily) would collapse into one, the running total would
-- stop moving while XP was still being gained, and the alert would fire DURING
-- activity. A missed alert is the worst outcome here, so that trade is not open.
--
-- The counter shows cumulative totals. A total changes the instant XP is gained
-- and then holds still, so there is no tail and nothing to dedupe. It is also what
-- AfkWarden read, via Alt1's XP reader.
--
-- A LEVEL, NOT EVENTS, and that closes an honesty hole the lag fix alone did not.
-- While XP arrived as drops, src/bolt-io/game-state.ts accumulated them into a
-- total that only ever grew -- so once one drop had been seen, `readXp` could
-- never return null again, and a reader that had gone BLIND (interface closed,
-- detection starved, font changed) was indistinguishable from "XP stopped" and
-- made xpcounter FIRE. A level can be absent at any moment, so blindness now
-- reads as no data instead of as an alert.
--
-- WHAT IS ANCHORED AND WHAT IS ORDINAL.
--
-- Anchored on the literal "XP" column header, and on nothing else. The interface
-- draws two stacked tables -- "XP | XP/h | ETA" above "Gain | Drops | GP/h" -- and
-- the lower one is full of large comma-separated numbers that would read as XP if
-- the anchor were merely "a number". Requiring "XP" separates them. Requiring
-- "XP/h" and "ETA" as well was considered and rejected: those columns are
-- user-configurable, so anyone with one switched off would go permanently blind,
-- and blindness resolves to silence, which is worse than the failure it replaced.
--
-- Everything below the header is ORDINAL rather than positional: the XP column is
-- the leftmost, confirmed by the user, so a row's XP cell is simply the FIRST
-- numeric run on that row. That needs no pixel constant for column extents or
-- alignment, which is the part of an earlier design that was guessing.
--
-- STILL UNVERIFIED AGAINST A LIVE CLIENT, and built to say so. The diagnostics
-- report whether the header was found and the raw text of every cell read, and
-- lua/detect/probe.lua now dumps the text actually drawn. If this reads nothing,
-- one probe sample says why rather than prompting another guess.

local text = require("lua.detect.text")

local M = {}

--- The column header that identifies the XP table.
local HEADER = "XP"

--- Rows read at once. A counter holds a handful; the cap bounds a pathological
--- batch rather than expressing a belief about the interface.
local MAX_ROWS = 24

--- Published on the tick, and the tick in progress.
local totals, wiptotals = nil, nil
local cells, wipcells = {}, {}
local found, wipfound = false, false
local coarse, wipcoarse = false, false
--- Set when a cell sat next to a glyph the font table could not resolve, so the
--- number read from it may be missing a digit. See the note at the parse site.
local suspect, wipsuspect = false, false

--- Publish what the tick gathered, then start clean.
---
--- Same shape as the other detectors and for the same reason: main.lua calls
--- request and then reads in one callback, so anything reset in place without
--- publishing first reads back empty.
function M.request()
  totals = wiptotals
  cells = wipcells
  found = wipfound
  coarse = wipcoarse
  suspect = wipsuspect

  wiptotals = nil
  wipcells = {}
  wipfound = false
  wipcoarse = false
  wipsuspect = false
end

--- The XP totals read on the last tick, or nil when the counter was not readable.
---
--- Nil is the honest answer and the important one: it becomes `functional: false`
--- and a "no data" badge, rather than a total that stopped moving and reads as
--- "you stopped gaining XP".
function M.read()
  return totals
end

--- What the last tick saw, for the detection panel.
function M.diagnostics()
  return { found = found, cells = cells, coarse = coarse, suspect = suspect }
end

--- Read the counter out of one batch.
--- @param scanning boolean|nil false once this frame's scan budget is spent.
---
--- NO CHAT-BATCH EXCLUSION, AND REMOVING IT FIXED A TOTAL FAILURE. While XP meant
--- reading floating "+N" text, a chat line saying "+50" was indistinguishable from
--- a drop, so batches chat had claimed were skipped. Anchored on a column header
--- instead, that exclusion buys almost nothing -- a chat line would have to
--- contain "XP" as its own run above rows whose leftmost run is a number -- and it
--- costs everything if the counter happens to share a render batch with chat,
--- which is not something this side can see or control. Skipping a real interface
--- to avoid an implausible impostor is the wrong trade.
function M.onrender2d(event, scanning)
  if scanning == false then return end

  -- Collected first, then reasoned about. Runs arrive in draw order, which is not
  -- reading order, so rows cannot be assembled on the fly.
  local runs = {}
  -- `issuspect` rather than `suspect`, which is a module-level local this would
  -- otherwise shadow.
  text.scan(event, function (run, box, issuspect)
    runs[#runs + 1] = {
      text = run,
      left = box.left,
      right = box.right,
      bottom = box.bottom,
      suspect = issuspect == true,
    }
  end)
  if #runs == 0 then return end

  -- The header. Its baseline is where the table starts.
  local headerbottom = nil
  for _, r in ipairs(runs) do
    if r.text == HEADER then
      if headerbottom == nil or r.bottom < headerbottom then headerbottom = r.bottom end
    end
  end
  if headerbottom == nil then return end

  wipfound = true

  -- THE TABLE IS BOUNDED BY THE "XP" HEADER'S OWN LEFT EDGE, and it has to be.
  --
  -- Confirmed by a live reading on 2026-08-09: the counter and the CHAT BOX are
  -- drawn in the same render2d batch (both batch 23), so every chat line is a
  -- candidate row. It read correctly only because the "Gain" header sorts above the
  -- chat log and ended the scan first, which is luck rather than a design.
  --
  -- ANCHORED ON THE "XP" RUN, NOT ON EVERYTHING SHARING ITS BASELINE. A previous
  -- version took min/max over every run within the baseline tolerance -- which
  -- contradicted this very comment -- so ONE unrelated run whose baseline landed
  -- within six pixels of the header collapsed the left bound from 3041 to that
  -- run's x, and the row filter then admitted everything to its left.
  --
  -- The consequence was not "no data". A foreign column of plain numbers on an
  -- ordinary 27px pitch REPLACED all three XP cells -- reproduced through the real
  -- plugin, publishing 3,006 against a true 64,797,401, with xpCounterFound true
  -- and xpCoarse false. Confidently wrong. And if such a number drifts upward while
  -- XP is static, xpcounter resets its timer on every step and the inactivity alert
  -- NEVER fires.
  --
  -- The XP column is leftmost, so its header IS the left edge. Extending right only
  -- over runs at or right of it keeps the other columns in while letting nothing to
  -- the left widen the span. In that reading the headers run 3041..3237 while chat
  -- sits at x=10 and x=638 and the summoning readout at 2384.
  -- The XP column is leftmost, so its header is the left edge by definition.
  -- Extending right only over runs at or right of it keeps the other columns in
  -- while letting nothing to the left widen the span.
  local headerleft, headerright = nil, nil
  for _, r in ipairs(runs) do
    if r.text == HEADER and math.abs(r.bottom - headerbottom) <= text.BASELINE_TOLERANCE then
      if headerleft == nil or r.left < headerleft then headerleft = r.left end
      if headerright == nil or r.right > headerright then headerright = r.right end
    end
  end
  if headerleft == nil then return end

  for _, r in ipairs(runs) do
    if math.abs(r.bottom - headerbottom) <= text.BASELINE_TOLERANCE
      and r.left >= headerleft and r.right > headerright then
      headerright = r.right
    end
  end

  -- Rows below the header, keyed by baseline. A row is one baseline: every cell
  -- on it shares a bottom edge whatever heights its glyphs happen to be.
  local rows = {}
  for _, r in ipairs(runs) do
    if r.bottom > headerbottom + text.BASELINE_TOLERANCE
      and r.left >= headerleft and r.left <= headerright then
      local key = nil
      for _, row in ipairs(rows) do
        if math.abs(row.bottom - r.bottom) <= text.BASELINE_TOLERANCE then key = row break end
      end
      if key == nil and #rows < MAX_ROWS then
        key = { bottom = r.bottom, runs = {} }
        rows[#rows + 1] = key
      end
      if key ~= nil then key.runs[#key.runs + 1] = r end
    end
  end

  table.sort(rows, function (a, b) return a.bottom < b.bottom end)

  local sum = 0
  local read = 0
  -- COLLECTED PER BATCH AND ASSIGNED WHOLE, not appended to. The counter is
  -- redrawn on every frame of the tick, so appending made the diagnostics report a
  -- multiple of the real row count and then saturate at the cap -- a panel meant to
  -- expose a misread was itself misreading.
  local cellsread = {}

  for _, row in ipairs(rows) do
    -- Leftmost first, so "the first numeric run" means the leftmost one.
    table.sort(row.runs, function (a, b) return a.left < b.left end)

    local value, wascoarse = nil, false
    local cell = nil
    for _, r in ipairs(row.runs) do
      local n, c = text.number(r.text)
      if n ~= nil then
        value, wascoarse, cell = n, c, r.text
        -- A RUN NEXT TO AN UNRESOLVABLE GLYPH IS A FRAGMENT, NOT A SMALLER NUMBER.
        -- "37,138,020" missing one digit parses cleanly as 3,713,802 or 371, which
        -- is indistinguishable from a real total and orders of magnitude out. The
        -- whole reading is refused below rather than this cell being skipped,
        -- because dropping a row would silently undercount the sum instead.
        if r.suspect then wipsuspect = true end
        break
      end
    end

    if value == nil then
      -- A row of WORDS is the next table's header ("Gain | Drops | GP/h"), so the
      -- XP table has ended. Stopping there rather than filtering by x is what
      -- keeps the lower table's equally large numbers out without needing to know
      -- where either table sits.
      --
      -- A row with neither a number nor a word is a FRAGMENT and is skipped, not
      -- treated as the end. That distinction is load-bearing: an orphaned '/' from
      -- a "XP/h" header once landed four pixels below the header row and ended the
      -- table before a single value had been read, which presented as the counter
      -- not being on screen at all.
      local word = false
      for _, r in ipairs(row.runs) do
        if string.match(r.text, "%a") ~= nil then word = true break end
      end
      if word then break end
    else
      read = read + 1
      sum = sum + value
      if wascoarse then wipcoarse = true end
      if #cellsread < MAX_ROWS then cellsread[#cellsread + 1] = cell end
    end
  end

  if read == 0 then return end

  -- A TRUNCATED TABLE UNDERCOUNTS THE SUM, so it is refused rather than published.
  -- The cap exists to bound a pathological batch, not to express a belief about how
  -- many rows a counter has -- and a total missing a row looks exactly like a real
  -- one to an alerter that only diffs it.
  if #rows >= MAX_ROWS then return end

  wipcells = cellsread

  -- ABBREVIATED CELLS ARE NOT USED. "37.1M" is a real reading but only moves on a
  -- gain of tens of thousands, so an inactivity alert built on it would fire while
  -- training continues. Reported with a reason -- widen the counter -- rather than
  -- acted on.
  if wipcoarse then return end

  -- A fragment is refused for the same reason an abbreviation is: it is a number
  -- that parses cleanly and is wrong, which every alerter would diff as real.
  if wipsuspect then return end

  -- Summed across rows and published under "tot" only. A row is identified by its
  -- skill ICON, and reading that means hashing the sprite and having the user bind
  -- each hash to one of AfkWarden's three-letter codes -- a picker and a training
  -- step, deliberately not built yet. The sum answers the only question every
  -- alerter here asks, which is whether the total moved.
  wiptotals = { tot = sum }
end

return M
