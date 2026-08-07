-- AFK Goblin — Bolt plugin entry point.
--
-- Wiring only: create the UI, push state, route inbound requests. Detection
-- belongs in lua/detect/*, rule evaluation belongs in the browser.
-- See docs/superpowers/specs/2026-08-06-bolt-migration-design.md.

local bolt = require("bolt")
bolt.checkversion(1, 0)

local bridge = require("lua.bridge")
local chat = require("lua.detect.chat")

-- The master tick, matching the engine's TICK_MS on the browser side.
local TICK_US = 600000

-- TODO(P1.4): flip to app/index.html once the engine seam consumes the bridge.
-- Until then the app still reads Alt1 and would show nothing but empty state,
-- whereas the probe exercises the bridge and reports what actually arrived.
local UI_URL = "plugin://app/probe.html"

local browser = bolt.createembeddedbrowser(0, 0, 480, 640, UI_URL)
local link = bridge.new(browser)

-- CEF disables window.close(), so the UI self-closes via the /close-request
-- endpoint, which lands here.
browser:oncloserequest(bolt.close)

--- Milliseconds between two bolt.time() readings.
--
-- bolt.time() is monotonic MICROseconds from an arbitrary origin, and wraps
-- roughly hourly on a 32-bit CPU. It is not a wall clock and must never be sent
-- as one: only durations cross the bridge, and the browser stamps its own
-- Date.now(). A wrap would otherwise produce a negative duration, which the
-- schema rejects, so it is clamped here.
local function elapsedms(since, now)
  local delta = now - since
  if delta < 0 then return 0 end
  return math.floor(delta / 1000)
end

-- Activity timers.
--
-- Bolt exposes no keyboard events, so activity is mouse-derived: clicks, motion
-- and scroll. This matches or beats Alt1, whose rsLastActive is click-only and
-- whose movement signal was polled rather than event-driven. Deliberately out of
-- scope: see the migration spec.
local lastclick = bolt.time()
local lastmove = bolt.time()

bolt.onmousebutton(function ()
  local now = bolt.time()
  lastclick = now
  lastmove = now
end)
bolt.onmousemotion(function () lastmove = bolt.time() end)
bolt.onscroll(function () lastmove = bolt.time() end)

bolt.onrender2d(function (event) chat.onrender2d(event) end)

--- Bolt's character strings are empty or NUL-led when not logged in.
local function nonempty(value)
  if type(value) == "string" and #value > 0 and string.byte(value) ~= 0 then return value end
  return nil
end

--- The stable per-character id, or nil in the lobby.
--
-- Confirmed in-game (P1.8): empty before login, populated after, so it doubles
-- as the login signal. This is an opaque hash that Bolt's docs ask callers to
-- treat as private; it also names the on-disk config file. It must never be
-- sent over the bridge or shown in the UI — use charactername() for display.
local function characterid()
  return nonempty(bolt.characterid())
end

--- The character's display name, or nil in the lobby.
--
-- Reported on every snapshot rather than on the startup handshake, because the
-- plugin starts long before login and the handshake value was always empty.
local function charactername()
  return nonempty(bolt.charactername())
end

-- Inbound: persist the config blob the UI owns. Lua stores it verbatim and never
-- parses it, so the schema stays in one place.
link:on("save", function (message)
  if type(message.data) == "string" then bridge.saveconfig(message.data) end
end)

-- flashwindow already does nothing when the window is focused, so it needs no guard.
link:on("flash", function () bolt.flashwindow() end)

local major, minor = bolt.apiversion()
link:send({ t = "hello", apiVersion = { major, minor } })

-- Hand the stored config over once at startup. The UI is the only thing that
-- understands its shape.
local stored = bridge.loadconfig()
if stored ~= nil then
  link:send({ t = "config", data = stored })
end

local tick = 0
local lasttick = bolt.time()

bolt.onswapbuffers(function ()
  local now = bolt.time()
  if now >= lasttick and now - lasttick < TICK_US then return end
  lasttick = now
  tick = tick + 1

  -- Ask for one chat scan per tick. render2d fires many times a frame, and
  -- scanning every one of them is pure waste.
  chat.request()

  local lines = chat.drain()
  if lines ~= nil then
    local out = {}
    for i, text in ipairs(lines) do
      -- The module reads text but reports no colour. The browser treats an empty
      -- colour list as "unknown" and declines to filter on it, rather than
      -- treating it as a mismatch that would silence every colour-filtered alert.
      out[i] = { text = text, colors = {}, fragments = { text } }
    end
    link:send({ t = "chat", lines = out })
  end

  link:send({
    t = "state",
    tick = tick,
    clickIdleMs = elapsedms(lastclick, now),
    mouseIdleMs = elapsedms(lastmove, now),
    -- Known-unreliable on Windows: Bolt implements this with GetFocus(), which
    -- only reports a focus window belonging to the calling thread's message
    -- queue, and this runs on the render thread. It is therefore always false
    -- there. Sent anyway so the browser can see what it is being told.
    focused = bolt.isfocused(),
    -- Gated on the id, not the name: the id is the stable signal, and a display
    -- name could in principle be blank without meaning "logged out".
    loggedIn = characterid() ~= nil,
    characterName = charactername(),
    chatAvailable = chat.available(),
    chatScrolledUp = chat.scrolledup(),
    chatBoxes = chat.boxcount(),
  })
end)
