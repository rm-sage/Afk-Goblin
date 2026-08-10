-- Reading text out of a render2d batch, one run of glyphs at a time.
--
-- Factored out because three callers need the same walk and getting it wrong is
-- not obvious: lua/detect/xp.lua reads the XP counter, lua/detect/probe.lua dumps
-- what was drawn, and any future interface reader wants the same thing. It had
-- already been written once, wrongly, in xp.lua.
--
-- GROUP BY THE BOTTOM EDGE, NOT THE TOP. modules/chat/chat.lua's `chatchars` is
-- keyed by a glyph's own bounding-box height, not by font size: at one size digits
-- and capitals are 8 tall, '+' is 6, ',' is 4, '.' is 3 and '/' is 13. Text sits
-- on a shared BASELINE, so those quads all END at the same y and START several
-- pixels apart. Grouping a run by its top edge therefore splits it at every comma
-- -- which is how "+1,234" once read as 1 -- and splits after a '+' at any font
-- size where '+' and the digits do not happen to share a height.
--
-- THE FONT TABLE IS THE CHEAP FILTER. Resolving a glyph reads pixels, and
-- `chatchars` is keyed by atlas height, so anything not drawn at a known glyph
-- height is rejected by one table index rather than by a texture read. That is
-- what makes walking every batch affordable at all.

local chatmodule = require("modules.chat.chat")

local M = {}

--- Largest gap BETWEEN two glyph boxes still counted as one run, in pixels.
---
--- Measured edge to edge rather than between left edges. An advance-based figure
--- has to be loose enough for the largest font and is then far too loose for the
--- smallest; a real gap barely changes with scale.
M.MAX_GLYPH_GAP = 6

--- How far two glyphs' bottom edges may differ and still count as one line.
---
--- SIX, FROM A MEASUREMENT, AND THREE WAS WRONG. A live reading of the XP counter
--- header (2026-08-09) gives, verbatim:
---
---   text "XP" at 3128,1111 13x9
---   text "/"  at 3142,1115 5x16
---   text "h"  at 3147,1111 6x10
---
--- '/' is a 16-tall glyph against 9-tall capitals and hangs FOUR pixels below
--- their baseline. At a tolerance of three it broke away, so "XP/h" fragmented
--- into "XP", "/" and "h" -- which made the XP/h column header produce a run
--- exactly equal to "XP" and therefore indistinguishable from the XP column
--- header, and left an orphaned "/" sitting four pixels below the header row where
--- it read as a table row of its own.
---
--- Six is still far inside the gap between real rows, which that same reading puts
--- at 27 pixels (1136, 1163, 1190).
M.BASELINE_TOLERANCE = 6

--- Walk one batch and hand every run of glyphs to `onrun(text, box, suspect)`.
---
--- `suspect` is true when a glyph adjacent to this run could not be resolved, and
--- a caller reading a NUMBER must refuse the run rather than use it.
---
--- WHY, AND IT WAS A CONFIDENTLY WRONG TOTAL. An unresolvable glyph used to be
--- skipped with no record, and because the position trackers are only updated for
--- resolved glyphs the skipped one's width became a gap that exceeded
--- MAX_GLYPH_GAP -- so the run silently ENDED there too. "37,138,020" with one
--- interior glyph missing from the font table published 371 as an exact total, and
--- `chatchars` is a hand-derived table for the CHAT font while the XP counter is a
--- different interface, so a weight or size it does not cover yields a stable value
--- orders of magnitude too small. Both XP alerters then measure the user's
--- thresholds against a fragment, and if resolution is intermittent the total
--- oscillates upward on every recovery and the inactivity alert never fires.
---
--- `box` is `{ left, right, top, bottom }` in screen pixels. Runs arrive in draw
--- order, which is not reading order -- a caller that needs rows must group them
--- itself, because only the caller knows what a row means for its interface.
---
--- Both corners of each quad are read and reduced with min/max rather than
--- assuming which vertex is which, so a flipped or stretched text quad at a
--- fractional interface scale still measures right.
function M.scan(event, onrun)
  local vertexcount = event:vertexcount()
  local vpi = event:verticesperimage()

  local run, runbox = nil, nil
  local lastleft, lastright, lastbottom, lasttop, lastax, lastay
  --- Set when a glyph could not be resolved, so the next run it touches is
  --- reported as suspect. Cleared once that run has been handed over.
  local dropped = false

  local function flush()
    if run ~= nil and #run > 0 then onrun(run, runbox, dropped) end
    run, runbox = nil, nil
    dropped = false
  end

  for i = 1, vertexcount, vpi do
    local ax, ay, aw, ah = event:vertexatlasdetails(i)

    if ah ~= nil and chatmodule.chatchars[ah] ~= nil then
      local x1, y1 = event:vertexxy(i)
      local x2, y2 = event:vertexxy(i + 2)

      if x1 ~= nil and y1 ~= nil and x2 ~= nil and y2 ~= nil then
        local left = math.min(x1, x2)
        local right = math.max(x1, x2)
        local top = math.min(y1, y2)
        local bottom = math.max(y1, y2)

        -- A glyph's colour copy sits within a pixel of its shadow with the same
        -- atlas entry, so the pair collapses onto whichever was drawn first.
        local duplicate = lastleft ~= nil
          and math.abs(left - lastleft) < 2 and math.abs(top - lasttop) < 2
          and ax == lastax and ay == lastay

        if not duplicate then
          local ok, char = pcall(chatmodule.lookupchatcharacter, chatmodule, event, ax, ay, aw, ah)
          char = ok and char or nil

          if char ~= nil then
            local continues = run ~= nil
              and math.abs(bottom - lastbottom) <= M.BASELINE_TOLERANCE
              and left >= lastleft
              and (left - lastright) <= M.MAX_GLYPH_GAP

            if continues then
              run = run .. tostring(char)
              runbox.right = right
              if top < runbox.top then runbox.top = top end
              if bottom > runbox.bottom then runbox.bottom = bottom end
            else
              flush()
              run = tostring(char)
              runbox = { left = left, right = right, top = top, bottom = bottom }
            end

            lastleft, lastright, lastbottom, lasttop = left, right, bottom, top
            lastax, lastay = ax, ay
          else
            -- Drawn at a glyph height the font table knows, yet not resolvable.
            -- Whatever run it sat in is now missing a character, and a number
            -- missing a digit is not a smaller number -- it is unreadable. End the
            -- run here deliberately and mark it, rather than letting the gap do it
            -- silently.
            dropped = true
            flush()
            dropped = true
          end
        end
      end
    end
  end

  flush()
end

--- Parse a run as a whole number, or nil.
---
--- Accepts thousands separators and a k/m suffix, both of which the game uses.
--- Returns the number and whether it was ABBREVIATED -- "37.1M" is a real reading
--- but a coarse one, and a caller watching for change needs to know that it only
--- moves on a gain of tens of thousands.
function M.number(text)
  if text == nil then return nil, false end

  local body = text
  local multiplier = 1
  local coarse = false

  local suffix = string.sub(body, -1)
  if suffix == "k" or suffix == "K" then
    multiplier = 1000
    body = string.sub(body, 1, -2)
    coarse = true
  elseif suffix == "m" or suffix == "M" then
    multiplier = 1000000
    body = string.sub(body, 1, -2)
    coarse = true
  end

  body = string.gsub(body, ",", "")
  if body == "" then return nil, false end
  if string.match(body, "^%d+%.?%d*$") == nil then return nil, false end

  local n = tonumber(body)
  if n == nil then return nil, false end
  return math.floor((n * multiplier) + 0.5), coarse
end

return M
