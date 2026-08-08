-- Test driver for the Lua plugin layer: a fake Bolt host and fake detection
-- modules, so main.lua and lua/detect/* can be driven frame by frame from a unit
-- test.
--
-- WHY THIS EXISTS. Everything under lua/ runs inside the game process and used
-- to be untestable by construction, so its bugs were only ever found by playing
-- the game and noticing something missing. That cost two live sessions to one
-- bug: buffs.request() cleared the buff list and main.lua read it back in the
-- same callback, so the bridge sent an empty list forever. Nothing in 294
-- browser-side tests could see it, because the mistake was in the wiring
-- between Lua modules rather than inside any one of them.
--
-- WHAT IS FAKED AND WHAT IS NOT. The Bolt host is faked, because it is a game
-- client. The two vendored detection modules are faked, because they read pixel
-- data out of a live texture atlas and no fixture can honestly stand in for
-- that. Everything this repo actually wrote -- main.lua, lua/bridge.lua,
-- lua/json.lua and lua/detect/* -- is the real thing. The seam is deliberately
-- drawn where our code ends.

local json = require("lua.json")

local D = {}

--- Monotonic microseconds, exactly as bolt.time() reports them.
D.time = 0

--- How many times onswapbuffers fires per rendered frame.
---
--- Not a hypothetical. Bolt raises this on every buffer swap the client makes,
--- and the client is not obliged to make exactly one per frame. Any detection
--- built as "open a window at the tick, close it at the next swap" then closes
--- its window before a single render2d event has arrived, and reads nothing at
--- all, forever. Set this above 1 to reproduce that.
D.swapsperframe = 1

--- Everything the plugin sent to its browser, as raw JSON strings.
D.sent = {}

--- Host state the plugin reads back.
D.characterid = "character-hash"
D.charactername = "Sage"
D.focused = false
D.storedconfig = {}

--- Callbacks main.lua registered, by Bolt event name.
D.handlers = {}

--- The handler passed to browser:oncloserequest, kept so a test can assert the
--- UI's close request really reaches bolt.close.
D.onclose = nil
D.closed = false
D.flashes = 0

--- Handler for messages sent FROM the browser, registered via browser:onmessage.
D.onmessage = nil

-- ---------------------------------------------------------------- fake events

local VERTICES_PER_IMAGE = 6

--- The image an index falls inside, 1-based. Mirrors how the real events pack
--- six vertices per quad, which is the step every caller loops by.
local function imageat(images, index)
  return images[math.floor((index - 1) / VERTICES_PER_IMAGE) + 1]
end

--- A render2d event over a list of image specs.
---
--- Each spec may carry `ax`, `ay`, `aw`, `ah` (its place and size in the texture
--- atlas), `x`/`y` (screen position of the top-left vertex, offset 2) and
--- `x2`/`y2` (offset 0, the opposite corner), plus `texture`, a byte string
--- returned by texturedata.
local function render2devent(images)
  local E = {}

  function E:vertexcount() return #images * VERTICES_PER_IMAGE end
  function E:verticesperimage() return VERTICES_PER_IMAGE end

  function E:vertexatlasdetails(index)
    local img = imageat(images, index)
    if img == nil then return nil end
    return img.ax or 0, img.ay or 0, img.aw or 0, img.ah or 0
  end

  --- Offset 2 within an image is its top-left; offset 0 is the far corner.
  --- stats.lua depends on that difference to measure a bar's drawn width.
  function E:vertexxy(index)
    local img = imageat(images, index)
    if img == nil then return nil end
    local within = (index - 1) % VERTICES_PER_IMAGE
    if within == 2 then return img.x or 0, img.y or 0 end
    return img.x2 or ((img.x or 0) + (img.aw or 0)), img.y2 or ((img.y or 0) + (img.ah or 0))
  end

  --- Pixels at an absolute position in the atlas.
  ---
  --- Resolved by which image's atlas rectangle CONTAINS the point, because
  --- callers sample a pixel offset into a bar they just found and several bars
  --- share one batch. `rgb` is the convenient form; `texture` passes bytes
  --- through untouched for anything that needs more than one pixel.
  function E:texturedata(x, y)
    for _, img in ipairs(images) do
      local ax, ay = img.ax or 0, img.ay or 0
      if x >= ax and x < ax + (img.aw or 0) and y >= ay and y < ay + (img.ah or 0) then
        if img.texture ~= nil then return img.texture end
        if img.rgb ~= nil then
          return string.char(img.rgb[1] or 0, img.rgb[2] or 0, img.rgb[3] or 0, 255)
        end
        return nil
      end
    end
    return nil
  end

  --- Texture coordinates, or nil for an untextured image.
  ---
  --- A nil uv is how Bolt says "this is a flat colour fill, not a sprite" -- the
  --- vendored buff module relies on exactly that check. Interface elements drawn
  --- as fills have no atlas entry at all, so any detector matching on atlas size
  --- is blind to them, which is the sort of thing the probe exists to reveal.
  function E:vertexuv(index)
    local img = imageat(images, index)
    if img == nil or img.flat ~= nil then return nil end
    return 0, 0
  end

  --- Vertex colour, as the 0..1 floats Bolt reports.
  ---
  --- Distinct from `rgb`, which is what the TEXTURE contains. The game tints a
  --- shared sprite per use, so an image's pixels and its colour on screen are
  --- two different readings and a fixture has to be able to disagree about them.
  --- Defaults to white, the neutral tint.
  function E:vertexcolour(index)
    local img = imageat(images, index)
    local c = img ~= nil and (img.tint or img.flat) or nil
    if c == nil then return 1, 1, 1, 1 end
    return (c[1] or 0) / 255.0, (c[2] or 0) / 255.0, (c[3] or 0) / 255.0, 1
  end

  -- Exposed so the fake modules below can find the spec they are being asked
  -- about. The real modules read pixels for this; the fake reads the script.
  function E:_images() return images end

  return E
end

--- An onrendericon event for one icon.
local function iconevent(spec)
  local E = {}
  function E:modelcount() return spec.models or 1 end
  function E:modelvertexcount() return spec.verts or 0 end
  function E:xywh() return spec.x or 0, spec.y or 0, spec.w or 32, spec.h or 32 end
  return E
end

-- --------------------------------------------------------------- fake modules

--- Stands in for modules/chat/chat.lua.
---
--- Answers from the frame script rather than from pixels. chat.lua calls this
--- with the index just past the speech-bubble image it found, so the bubble is
--- one image back — the same anchoring the real module documents.
local fakechat = {}

function fakechat:tryreadchat(event, startindex, prevmostrecent, callback)
  local img = imageat(event:_images(), startindex - VERTICES_PER_IMAGE)
  if img == nil or img.chat == nil then return nil end
  if img.chat.scrolled then return true, true end

  -- The real module stops when it reaches the message it was last given, and
  -- calls back only for the newer ones, oldest first.
  local seenprev = prevmostrecent == nil
  for _, message in ipairs(img.chat.messages or {}) do
    if seenprev then
      callback(message)
    elseif message == prevmostrecent then
      seenprev = true
    end
  end

  return true, nil
end

--- Stands in for modules/buffs/buffs.lua. buffs.lua always passes a start index
--- of 1, so the answer hangs off the event's first image.
local fakebuffs = {}

function fakebuffs:tryreadbuffdetails(event, startindex, pxleft, pxtop)
  local img = imageat(event:_images(), startindex)
  if img == nil or img.buff == nil then return false end
  local b = img.buff
  if not b.valid then return false end

  -- The real module confirms the buff outline sits exactly where the caller said
  -- its icon was, and returns false otherwise. That check is what makes trying
  -- several waiting icons against one batch safe rather than a guess, so a fake
  -- without it would let a broken pairing pass. `at` opts a fixture in.
  if b.at ~= nil and (pxleft ~= b.at[1] or pxtop ~= b.at[2]) then return false end

  return true, b.number, b.parens, b.isbuff ~= false
end

-- ------------------------------------------------------------------ fake bolt

local browser = {}

function browser:onmessage(callback) D.onmessage = callback end
function browser:sendmessage(text) D.sent[#D.sent + 1] = text end
function browser:oncloserequest(callback) D.onclose = callback end
function browser:close() end

local fakebolt = {}

function fakebolt.checkversion() end
function fakebolt.apiversion() return 1, 0 end
function fakebolt.time() return D.time end
function fakebolt.createbrowser() return browser end
function fakebolt.close() D.closed = true end
function fakebolt.flashwindow() D.flashes = D.flashes + 1 end
function fakebolt.isfocused() return D.focused end
function fakebolt.characterid() return D.characterid end
function fakebolt.charactername() return D.charactername end
function fakebolt.saveconfig(name, data) D.storedconfig[name] = data end
function fakebolt.loadconfig(name) return D.storedconfig[name] end

for _, name in ipairs({
  "onmousebutton", "onmousemotion", "onscroll",
  "onrender2d", "onrendericon", "onswapbuffers",
}) do
  fakebolt[name] = function (callback) D.handlers[name] = callback end
end

package.preload["bolt"] = function () return fakebolt end
package.preload["modules.chat.chat"] = function () return fakechat end
package.preload["modules.buffs.buffs"] = function () return fakebuffs end

-- ------------------------------------------------------------------- steering

local function fire(name, event)
  local handler = D.handlers[name]
  if handler ~= nil then handler(event) end
end

--- Render one frame and swap buffers.
---
--- `events` is an ordered list, because order is the thing under test: an icon
--- is paired with the render2d that follows it, and each chat box arrives in a
--- render2d of its own.
---
---   { kind = "icon", models = 2, verts = 1344, x = 10, y = 20 }
---   { kind = "render2d", images = { ... } }
---
--- `dtus` advances the clock first, defaulting to one frame at 60fps. The tick
--- gate in main.lua reads that clock, so this is what decides whether a frame
--- also carries a tick.
function D.frame(spec, dtus)
  D.time = D.time + (dtus or 16000)

  for _, event in ipairs(spec or {}) do
    if event.kind == "icon" then
      fire("onrendericon", iconevent(event))
    else
      fire("onrender2d", render2devent(event.images or {}))
    end
  end

  -- The extra swaps carry no render events, which is the whole point: they are
  -- what a window opened on the first swap would be closed by.
  for _ = 1, D.swapsperframe do fire("onswapbuffers") end
end

--- Run `count` frames of nothing being drawn.
function D.idle(count, dtus)
  for _ = 1, (count or 1) do D.frame({}, dtus) end
end

--- Deliver a message from the browser to the plugin.
function D.fromui(text)
  if D.onmessage ~= nil then D.onmessage(text) end
end

--- Ask the UI to close, the way the real close button does.
function D.requestclose()
  if D.onclose ~= nil then D.onclose() end
end

--- Everything sent so far, as one JSON array, for the test to parse.
function D.dump()
  return "[" .. table.concat(D.sent, ",") .. "]"
end

return D
