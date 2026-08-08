-- Message bridge between the plugin and its embedded browser UI, plus config
-- persistence.
--
-- This file holds no game logic on purpose. Everything here runs inside the
-- game process, where an uncaught error stops the plugin (and Lua errors can
-- take the client with them). Detection lives in lua/detect/*; rule evaluation
-- lives in the browser. Both this file and those run under test in tests/lua/,
-- against a fake Bolt host.

local bolt = require("bolt")
local json = require("lua.json")

local M = {}

local CONFIG_EXT = ".json"
local DEFAULT_NAME = "config"

-- Config file names to try, most specific first.
--
-- Per-character config with a shared fallback: presets are usually account-wide,
-- but a second character should be able to diverge without clobbering the first.
local function confignames()
  local id = bolt.characterid()
  if type(id) == "string" and #id > 0 and string.byte(id) ~= 0 then
    return { id .. CONFIG_EXT, DEFAULT_NAME .. CONFIG_EXT }
  end
  return { DEFAULT_NAME .. CONFIG_EXT }
end

--- Returns the stored config blob, or nil if none has been written yet.
function M.loadconfig()
  for _, name in ipairs(confignames()) do
    local stored = bolt.loadconfig(name)
    if stored ~= nil then return stored end
  end
  return nil
end

--- Writes the config blob against the most specific name available.
function M.saveconfig(data)
  bolt.saveconfig(confignames()[1], data)
end

local Bridge = {}
Bridge.__index = Bridge

--- Wraps a browser object with JSON framing and a handler table.
function M.new(browser)
  local self = setmetatable({ browser = browser, handlers = {} }, Bridge)
  browser:onmessage(function (message) self:receive(message) end)
  return self
end

--- Sends a table to the UI as JSON.
--
-- Note that assigning nil to a field deletes it rather than encoding a null, so
-- anything optional arrives at the far side ABSENT. The TypeScript schema treats
-- absent as null for exactly those fields; do not rely on that for required ones.
function Bridge:send(message)
  local ok, encoded = pcall(json.encode, message)
  if not ok then
    print("afkgoblin: could not encode outgoing message: " .. tostring(encoded))
    return
  end
  self.browser:sendmessage(encoded)
end

--- Registers a handler for one inbound message type.
function Bridge:on(messagetype, handler)
  self.handlers[messagetype] = handler
end

--- Routes one inbound message from the UI.
--
-- Decode failures, unknown types and handler errors are all logged and swallowed.
-- Raising here would call error(), which stops the plugin outright — a malformed
-- message from a web page must never be able to do that.
function Bridge:receive(message)
  local ok, decoded = pcall(json.decode, message)
  if not ok or type(decoded) ~= "table" then
    print("afkgoblin: could not decode incoming message")
    return
  end

  local handler = self.handlers[decoded.t]
  if handler == nil then return end

  local handled, err = pcall(handler, decoded)
  if not handled then
    print("afkgoblin: handler for '" .. tostring(decoded.t) .. "' failed: " .. tostring(err))
  end
end

return M
