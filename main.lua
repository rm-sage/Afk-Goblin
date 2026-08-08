-- AFK Goblin — Bolt plugin entry point.
--
-- Wiring only: create the UI, push state, route inbound requests. Detection
-- belongs in lua/detect/*, rule evaluation belongs in the browser.
-- See docs/superpowers/specs/2026-08-06-bolt-migration-design.md.

local bolt = require("bolt")
bolt.checkversion(1, 0)

local bridge = require("lua.bridge")
local chat = require("lua.detect.chat")
local stats = require("lua.detect.stats")
local buffs = require("lua.detect.buffs")
local probe = require("lua.detect.probe")

-- The master tick, matching the engine's TICK_MS on the browser side.
local TICK_US = 600000

-- HOW LONG OF EACH TICK CHAT AND THE ACTION BAR ARE SCANNED FOR.
--
-- Their scans read the atlas entry of every image in every batch -- about 3,300
-- per frame per detector in a live client -- so running them on every frame of
-- every tick is what took five to ten FPS. Once per tick is all that is needed:
-- an interface element that is on screen is drawn on EVERY frame, so any window
-- covering a whole frame sees all of it.
--
-- Bounded by TIME rather than by frames, because Bolt gives no reliable frame
-- boundary -- see the note on onswapbuffers below, which is the assumption that
-- made chat blind for two sessions. A tenth of a second covers a complete frame
-- even on a client running at fifteen FPS, and several on a fast one, so it errs
-- towards seeing too much rather than too little.
local SCAN_BUDGET_US = 100000

-- The app. app/probe.html is still shipped and is the bridge diagnostics page;
-- point this at it temporarily when something needs debugging at the wire level.
local UI_URL = "plugin://app/index.html"

-- An EXTERNAL window, not an embedded one, and this is not a style preference.
--
-- Embedded browsers are offscreen-rendered, so the host has to forward input
-- into them, and Bolt forwards only mouse events -- there is no key handling
-- anywhere in its browser or library layers. Typing into an embedded browser is
-- therefore impossible, which makes it useless for a UI built around importing
-- presets and entering trigger text.
--
-- An external browser is a real OS window with its own handle, so Windows
-- delivers keyboard to it directly and Bolt is not involved. Same root cause as
-- bolt.isfocused() being stuck false: Bolt's Windows input layer does mouse
-- only.
local browser = bolt.createbrowser(560, 760, UI_URL)
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

-- Declared up here because the render handler reads `lasttick` for its scan
-- budget, and a local declared after a function is not an upvalue of it.
local tick = 0
local lasttick = bolt.time()

bolt.onmousebutton(function ()
  local now = bolt.time()
  lastclick = now
  lastmove = now
end)
bolt.onmousemotion(function () lastmove = bolt.time() end)
bolt.onscroll(function () lastmove = bolt.time() end)

bolt.onrender2d(function (event)
  -- One clock read per batch, rather than one atlas read per image: the whole
  -- point is that the expensive scans below get declined most of the time.
  local scanning = (bolt.time() - lasttick) < SCAN_BUDGET_US

  chat.onrender2d(event, scanning)
  stats.onrender2d(event, scanning)

  -- Buff PAIRING is not budgeted: its work is already proportional to the icons
  -- waiting rather than to everything on screen, and an icon's timer text can
  -- arrive at any point in the tick. The budget is passed in only because the
  -- outline sweep inside does walk every image, and that is exactly the cost the
  -- budget exists to bound. See the note on M.onrender2d.
  buffs.onrender2d(event, scanning)
  probe.onrender2d(event)
end)

-- The probe wants the signature buffs derived, not its own copy of the
-- derivation: two readings of the same icon that could disagree would make the
-- report useless for the one thing it is for.
bolt.onrendericon(function (event)
  probe.onrendericon(event, buffs.onrendericon(event))
end)

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

-- Inbound: sample one tick of the draw stream and report what was in it. Armed
-- from the UI and never left on -- see lua/detect/probe.lua.
link:on("probe", function () probe.arm() end)

local major, minor = bolt.apiversion()
link:send({ t = "hello", apiVersion = { major, minor } })

-- Hand the stored config over once at startup. The UI is the only thing that
-- understands its shape.
local stored = bridge.loadconfig()
if stored ~= nil then
  link:send({ t = "config", data = stored })
end


-- ONSWAPBUFFERS IS NOT A FRAME BOUNDARY, and detection must not treat it as
-- one. Bolt raises it on every buffer swap the client makes, and the client is
-- free to make several per frame. Detection used to open a scan window here and
-- close it at the next swap; with more than one swap per frame that window
-- opened and closed before a single render2d event arrived, and chat and the
-- action bar were never scanned at all. All three detectors now scan every
-- frame and publish on the tick, and the only thing this callback decides is
-- when a tick has elapsed.
bolt.onswapbuffers(function ()
  local now = bolt.time()
  if now >= lasttick and now - lasttick < TICK_US then return end
  lasttick = now
  tick = tick + 1

  -- Close the tick that just ended and open the next.
  --
  -- ORDER MATTERS, AND IT BIT ONCE ALREADY. Each of these publishes what its
  -- tick gathered and then starts clean, so the reads below must come after
  -- them. buffs.request used to clear its lists WITHOUT publishing, so the read
  -- that followed it in this same callback always returned an empty list and the
  -- buff picker could never show anything — as did the counters meant to explain
  -- why. tests/lua/buffs.test.ts holds that case down.
  chat.request()
  stats.request()
  buffs.request()

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

  local buffslist, debuffslist = buffs.read()

  -- What detection actually saw, so an alert that never fires can be diagnosed
  -- from the UI instead of from a guess. Every field here is a count, and the
  -- interesting readings are the zeroes.
  local chatdiag = chat.diagnostics()
  local diag = {
    chatBubbles = chatdiag.bubbles,
    chatConfirmed = chatdiag.confirmed,
    chatScrolledBoxes = chatdiag.scrolledBoxes,
    chatBubblesEver = chatdiag.bubblesEver,
    chatConfirmedEver = chatdiag.confirmedEver,
    chatLines = chatdiag.lines,
    -- render2d events seen during the tick. Zero means detection is not being
    -- fed at all, which is a different problem from finding nothing in the feed
    -- -- and telling those apart is what took two sessions last time.
    render2dEvents = chatdiag.events,
    render2dScanned = chatdiag.scanned,
    buffIconDraws = buffs.iconcount(),
    buffIconsRead = buffs.parsedcount(),
    buffPairAttempts = buffs.attemptcount(),
    buffUnpaired = buffs.unpairedicons(),
    -- Every buff on the bar is outlined, but only buffs drawn from a rendered 3D
    -- model raise an icon event. More outlines than icons is the count of buffs
    -- detection cannot see at all.
    buffOutlines = buffs.outlinecount(),
    barsRead = stats.seencount(),
    chatAnchors = chatdiag.anchors,
  }

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
    stats = stats.read(),
    buffs = buffslist,
    debuffs = debuffslist,
    diag = diag,
  })

  -- Sent separately from the snapshot: it is large, occasional, and answers a
  -- different question. Nothing depends on it arriving.
  local report = probe.tick()
  if report ~= nil then link:send(report) end
end)
