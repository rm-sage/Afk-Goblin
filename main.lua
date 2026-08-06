-- AfkUAV — Bolt plugin entry point.
--
-- Wiring only: create the UI, push state, route inbound requests. Detection
-- belongs in lua/detect/*, rule evaluation belongs in the browser.
-- See docs/superpowers/specs/2026-08-06-bolt-migration-design.md.

local bolt = require("bolt")
bolt.checkversion(1, 0)

local bridge = require("lua.bridge")

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

--- Whether a character is loaded.
--
-- TODO(P1.8): confirm against the live client that characterid() actually
-- empties on logout. The login gate suppresses every alert when this is false,
-- so a wrong answer here is silently expensive in both directions.
local function loggedin()
  local id = bolt.characterid()
  return type(id) == "string" and #id > 0 and string.byte(id) ~= 0
end

local function characterid()
  local id = bolt.characterid()
  if type(id) == "string" and #id > 0 and string.byte(id) ~= 0 then return id end
  return nil
end

-- Inbound: persist the config blob the UI owns. Lua stores it verbatim and never
-- parses it, so the schema stays in one place.
link:on("save", function (message)
  if type(message.data) == "string" then bridge.saveconfig(message.data) end
end)

-- flashwindow already does nothing when the window is focused, so it needs no guard.
link:on("flash", function () bolt.flashwindow() end)

local major, minor = bolt.apiversion()
link:send({ t = "hello", apiVersion = { major, minor }, character = characterid() })

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

  link:send({
    t = "state",
    tick = tick,
    clickIdleMs = elapsedms(lastclick, now),
    mouseIdleMs = elapsedms(lastmove, now),
    focused = bolt.isfocused(),
    loggedIn = loggedin(),
  })
end)
