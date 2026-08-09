# Sprite-Drawn Buff Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect buffs whose icon is a plain authored sprite, which raise no `onrendericon` event and are therefore invisible to the plugin today — roughly half a real buff bar.

**Architecture:** Add a second detection path inside `lua/detect/buffs.lua`'s existing `M.onrender2d`. The outline sweep already runs there and records every buff/debuff outline quad; a second walk over the same batch offers the vendored module any textured image drawn at an outline's top-left. Identity for these comes from hashing the sprite's atlas pixels, since atlas rects are packed at runtime. New ids are additive, so no config migration.

**Tech Stack:** Lua 5.1 / LuaJIT 2.1 (plugin host), TypeScript + zod (wire), Preact (UI), vitest + wasmoon (tests; note the test VM is 5.4 and so is more permissive than the host).

## Global Constraints

- **Ids are additive.** Existing `models:verts` ids must keep working unchanged. Sprite ids use the `s:` prefix. No config migration.
- **The vendored module adjudicates.** Never conclude "this is a buff" from our own geometry; only `buffmodule:tryreadbuffdetails` returning true establishes that. `modules/` is read-only.
- **Cost bound is a requirement, not a hope.** Parse attempts must stay proportional to buffs on the bar, not to images per batch. An unfiltered scan was measured at 2,366 attempts/frame and cost 5–10 FPS.
- **New wire fields are defaulted** (`.default(...)`), because Lua deletes keys assigned nil and an older plugin must still decode against a newer UI.
- **Lua runs in the game process.** An uncaught error stops the plugin. Anything that can fail goes through `pcall`.
- After any change under `lua/` the plugin must be restarted in Bolt; `npm run build` alone only refreshes the browser UI.
- Every task ends green on `npm run typecheck && npm test`, and commits.

---

### Task 1: Teach the fake host that a texture has pixels at positions

The harness's `texturedata` resolves by which image's atlas rect contains the point and then returns the same bytes regardless of offset. A hash that samples 64 points would get 64 identical readings, so every sprite would hash alike and the identity tests would prove nothing.

**Files:**
- Modify: `tests/lua/driver.lua:101-113` (`E:texturedata`)
- Modify: `tests/lua/harness.ts` (add `spriteBuff` helper + `ImageSpec.texture` doc)
- Test: `tests/lua/buffs.test.ts`

**Interfaces:**
- Produces: `spriteBuff(opts)` returning a `Render2dEvent` laying out icon → text → outline in one batch, and a fake `texturedata(x, y, len)` that addresses `texture` as a row-major RGBA buffer, wrapping modulo its length.

- [x] **Step 1: Write the failing test**

In `tests/lua/buffs.test.ts`:

```ts
it("reads different bytes at different points of one texture", async () => {
  const plugin = await loadPlugin();
  plugin.frame([
    { kind: "render2d", images: [{ ax: 0, ay: 0, aw: 4, ah: 4, x: 0, y: 0, texture: "ABCDEFGHIJKLMNOP" }] },
  ]);
  const a = plugin.eval(`return driver.lastevent:texturedata(0, 0, 4)`);
  const b = plugin.eval(`return driver.lastevent:texturedata(1, 0, 4)`);
  expect(a).not.toEqual(b);
  plugin.close();
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lua/buffs.test.ts -t "different points"`
Expected: FAIL — both reads return the whole `texture` string, so they are equal (or `driver.lastevent` is nil).

- [x] **Step 3: Address the texture by position**

In `tests/lua/driver.lua`, replace `E:texturedata`:

```lua
  --- Pixels at an absolute position in the atlas.
  ---
  --- Resolved by which image's atlas rectangle CONTAINS the point, because
  --- callers sample a pixel offset into an image they just found and several
  --- share one batch.
  ---
  --- `texture` is addressed as a ROW-MAJOR RGBA BUFFER and wraps modulo its
  --- length, so a fixture can supply a short pattern and still have two sample
  --- points read differently. That difference is the whole point: a fake that
  --- answers identically everywhere would let a sprite hash that samples one
  --- pixel look exactly as good as one that samples sixty-four.
  ---
  --- `rgb` keeps its flat behaviour -- it means "this image is all one colour",
  --- which is what the action-bar fixtures rely on.
  function E:texturedata(x, y, len)
    len = len or 4
    for _, img in ipairs(images) do
      local ax, ay = img.ax or 0, img.ay or 0
      if x >= ax and x < ax + (img.aw or 0) and y >= ay and y < ay + (img.ah or 0) then
        if img.texture ~= nil and #img.texture > 0 then
          local tex = img.texture
          local offset = ((((y - ay) * (img.aw or 0)) + (x - ax)) * 4) % #tex
          local out = {}
          for i = 0, len - 1 do
            out[#out + 1] = tex:sub(((offset + i) % #tex) + 1, ((offset + i) % #tex) + 1)
          end
          return table.concat(out)
        end
        if img.rgb ~= nil then
          return string.char(img.rgb[1] or 0, img.rgb[2] or 0, img.rgb[3] or 0, 255)
        end
        return nil
      end
    end
    return nil
  end
```

In `tests/lua/driver.lua`, inside the render2d dispatch, record the event so a test can reach it. Find where `fire("onrender2d", ...)` is called and assign first:

```lua
    D.lastevent = event
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/lua/buffs.test.ts -t "different points"`
Expected: PASS

- [x] **Step 5: Add the sprite-buff fixture helper**

In `tests/lua/harness.ts`, after `buffDraw`:

```ts
/**
 * A buff whose icon is a plain sprite, laid out the way the game draws one:
 * icon, then its timer text, then the outline quad — all in ONE batch, with no
 * icon event anywhere. This is the case `onrendericon` structurally cannot see.
 *
 * The outline sits at the icon's exact top-left, which is the equality the
 * vendored module validates on and the filter the sprite path keys off.
 */
export function spriteBuff(opts: {
  at: { x: number; y: number };
  texture: string;
  number?: number | null;
  parens?: number | null;
  isbuff?: boolean;
  size?: number;
  atlasX?: number;
}): Render2dEvent {
  const size = opts.size ?? 27;
  const isbuff = opts.isbuff !== false;
  // EACH SPRITE NEEDS ITS OWN ATLAS RECT, and defaulting it to the bar position
  // is what gives it one. Identity is cached by rect, so two fixtures sharing a
  // rect would come back with one id however different their pixels are -- which
  // would make an id test pass for the wrong reason and hide a hash that never
  // looked at the texture at all.
  const ax = opts.atlasX ?? opts.at.x;
  return {
    kind: "render2d",
    images: [
      { ax, ay: 0, aw: size, ah: size, x: opts.at.x, y: opts.at.y, texture: opts.texture },
      {
        buff: {
          valid: true,
          number: opts.number ?? null,
          parens: opts.parens ?? null,
          isbuff,
          at: [opts.at.x, opts.at.y],
        },
      },
      { flat: isbuff ? [90, 150, 25] : [204, 0, 0], x: opts.at.x, y: opts.at.y, aw: size, ah: 1 },
      { flat: isbuff ? [90, 150, 25] : [204, 0, 0], x: opts.at.x, y: opts.at.y + 1, aw: 1, ah: size - 1 },
    ],
  };
}
```

- [x] **Step 6: Commit**

```bash
git add tests/lua/driver.lua tests/lua/harness.ts tests/lua/buffs.test.ts
git commit -m "Give the fake host per-pixel textures and a sprite-buff fixture"
```

---

### Task 2: Find buffs drawn as sprites

**Files:**
- Modify: `lua/detect/buffs.lua` (`M.onrender2d`)
- Test: `tests/lua/buffs.test.ts`

**Interfaces:**
- Consumes: `spriteBuff` from Task 1.
- Produces: sprite-found buffs appear in the state snapshot's `buffs`/`debuffs`. Internal helper `outlineat(x, y)` returning `true`/`false`/`nil`.

- [x] **Step 1: Write the failing test**

```ts
it("reads a buff drawn as a sprite, with no icon event at all", async () => {
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([spriteBuff({ at: { x: 1456, y: 990 }, texture: "sprite-one", number: 480 })]);
  }
  plugin.idle(1, TICK_US);
  const state = plugin.latest();
  expect(state?.buffs.length).toBe(1);
  expect(state?.buffs[0]?.timeLeft).toBe(480);
  expect(state?.diag.buffIconDraws).toBe(0);
  plugin.close();
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lua/buffs.test.ts -t "drawn as a sprite"`
Expected: FAIL — `buffs.length` is 0. Nothing reaches `pending` without an icon event.

- [x] **Step 3: Add the sprite pass**

In `lua/detect/buffs.lua`, add above `M.onrender2d`:

```lua
--- Whether an outline box was drawn at exactly this position this tick, and if
--- so whether it was a buff. nil when there was none.
local function outlineat(x, y)
  return wipoutlines[string.format("%d,%d", x, y)]
end

--- Positions already claimed by a paired icon this tick, so one buff cannot be
--- published twice under two different ids.
---
--- Bolt splits a recognised item-model quad OUT of the batch to raise its icon
--- event, so in principle the two paths see disjoint sets and this never fires.
--- That is a claim about Bolt's internals rather than something we control, and
--- a duplicated buff would show up as two entries in the picker that behave
--- differently -- so it is guarded rather than assumed.
local wipclaimed = {}
```

Add `wipclaimed = {}` to the reset block in `M.request()`, beside `wipoutlines = {}`.

In the icon-pairing loop, immediately after `seen[icon.id] = true` in the **successful parse** branch, add:

```lua
        wipclaimed[string.format("%d,%d", icon.x, icon.y)] = true
```

Then at the end of `M.onrender2d`, after the pending loop, add the sprite pass:

```lua
  -- SPRITE-DRAWN BUFFS, WHICH RAISE NO ICON EVENT AND ARE OTHERWISE UNREACHABLE.
  --
  -- Bolt raises onrendericon only for images it recognised as a rendered item
  -- model, so anything drawn from a plain authored sprite never reaches
  -- `pending` above however well the pairing works. Half a measured bar was
  -- invisible for exactly this reason.
  --
  -- This is the pattern modules/buffs/README.md documents and this file has
  -- never used: offer the module an image from THIS batch, with the details
  -- index just past it.
  --
  -- THE FILTER IS THE MODULE'S OWN EQUALITY, CHECKED EARLY. It validates a buff
  -- by finding an outline quad at precisely the icon's top-left
  -- (modules/buffs/buffs.lua:85). Asking that question first, off the outline
  -- table the sweep above just filled, is what keeps this to one parse attempt
  -- per buff on the bar instead of one per image per batch -- which was
  -- measured at 2,366 a frame and cost five to ten FPS.
  if scanning == false then return end

  local vertexcount = event:vertexcount()
  local verticesperimage = event:verticesperimage()

  for i = 1, vertexcount, verticesperimage do
    -- Textured only: an outline is itself a flat fill, and offering one to the
    -- module as though it were an icon would ask it about its own marker.
    if event:vertexuv(i) ~= nil then
      local x, y = event:vertexxy(i + 2)
      if x ~= nil and y ~= nil then
        local key = string.format("%d,%d", x, y)
        if outlineat(x, y) ~= nil and not wipclaimed[key] then
          wipattempts = wipattempts + 1
          local ok, valid, number, parens, isbuff =
            pcall(buffmodule.tryreadbuffdetails, buffmodule, event, i + verticesperimage, x, y)

          if ok and valid then
            local id = spriteid(event, i)
            if id ~= nil and not seen[id] then
              seen[id] = true
              wipclaimed[key] = true
              wipparsed = wipparsed + 1

              local slot = { id = id, timeLeft = number, stacks = parens, x = x, source = "sprite" }
              if isbuff then
                wipbuffs[#wipbuffs + 1] = slot
              else
                wipdebuffs[#wipdebuffs + 1] = slot
              end
            end
          end
        end
      end
    end
  end
```

Add a placeholder `spriteid` above `outlineat` for now — Task 3 replaces its body:

```lua
--- Stable identity for a sprite-drawn buff. Replaced in Task 3.
local function spriteid(event, index)
  local ax, ay, aw, ah = event:vertexatlasdetails(index)
  return string.format("s:%d,%d,%d,%d", ax or 0, ay or 0, aw or 0, ah or 0)
end
```

Also tag the icon path's slots with their source and position. In both places a slot table is built in the pending loop, change:

```lua
        local slot = { id = icon.id, timeLeft = number, stacks = parens }
```
to
```lua
        local slot = { id = icon.id, timeLeft = number, stacks = parens, x = icon.x, source = "icon" }
```

and the outline-fallback one:

```lua
          local slot = { id = icon.id }
```
to
```lua
          local slot = { id = icon.id, x = icon.x, source = "icon" }
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/lua/buffs.test.ts -t "drawn as a sprite"`
Expected: PASS

- [x] **Step 5: Add the cost-bound and no-outline tests**

```ts
it("never offers the module an image with no outline at its position", async () => {
  const plugin = await loadPlugin();
  plugin.frame([
    {
      kind: "render2d",
      images: Array.from({ length: 40 }, (_, i) => ({
        ax: 200, ay: 0, aw: 27, ah: 27, x: 10 + i, y: 700, texture: "inventory",
      })),
    },
  ]);
  plugin.idle(1, TICK_US);
  const state = plugin.latest();
  expect(state?.buffs.length).toBe(0);
  // 40 inventory icons, none outlined: not one parse attempt.
  expect(state?.diag.buffPairAttempts).toBe(0);
  plugin.close();
});

it("reads a debuff drawn as a sprite", async () => {
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([spriteBuff({ at: { x: 1456, y: 990 }, texture: "poison", number: 30, isbuff: false })]);
  }
  plugin.idle(1, TICK_US);
  expect(plugin.latest()?.debuffs.length).toBe(1);
  expect(plugin.latest()?.buffs.length).toBe(0);
  plugin.close();
});

it("publishes a buff once when both paths could see it", async () => {
  // The icon path claims the position, so the sprite pass must decline it.
  // Otherwise one buff arrives twice under two ids and the picker offers two
  // entries that behave differently.
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([
      { kind: "icon", models: 1, verts: 366, x: 1456, y: 990, w: 27, h: 27 },
      spriteBuff({ at: { x: 1456, y: 990 }, texture: "both-paths", number: 45 }),
    ]);
  }
  plugin.idle(1, TICK_US);
  const state = plugin.latest();
  expect(state?.buffs.length).toBe(1);
  // `source` is not on the wire until Task 4; this asserts only the count here.
  plugin.close();
});

it("publishes a sprite buff whose timer will not parse, with no timeLeft", async () => {
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([spriteBuff({ at: { x: 1456, y: 990 }, texture: "grace", number: null })]);
  }
  plugin.idle(1, TICK_US);
  const state = plugin.latest();
  expect(state?.buffs.length).toBe(1);
  expect(state?.buffs[0]?.timeLeft).toBeNull();
  plugin.close();
});
```

- [x] **Step 6: Run the whole file, then the suite**

Run: `npx vitest run tests/lua/buffs.test.ts` then `npm test`
Expected: all PASS

- [x] **Step 7: Commit**

```bash
git add lua/detect/buffs.lua tests/lua/buffs.test.ts
git commit -m "Detect buffs drawn as sprites, which raise no icon event"
```

---

### Task 3: Identify a sprite by hashing its pixels

**Files:**
- Modify: `lua/detect/buffs.lua` (replace the `spriteid` placeholder)
- Test: `tests/lua/buffs.test.ts`

**Interfaces:**
- Produces: ids of the form `s:%08x`, cached per atlas rect for the session.

- [x] **Step 1: Write the failing test**

```ts
it("gives two different sprites two different ids, and one sprite one id", async () => {
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([
      spriteBuff({ at: { x: 1456, y: 990 }, texture: "alpha-pattern", number: 60 }),
      spriteBuff({ at: { x: 1486, y: 990 }, texture: "beta-pattern", number: 90 }),
    ]);
  }
  plugin.idle(1, TICK_US);
  const ids = (plugin.latest()?.buffs ?? []).map((b) => b.id);
  expect(ids.length).toBe(2);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(id).toMatch(/^s:[0-9a-f]{8}$/);
  plugin.close();
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lua/buffs.test.ts -t "two different ids"`
Expected: FAIL — the placeholder yields `s:100,0,27,27` for both, so the set has one entry and the regex does not match.

- [x] **Step 3: Replace the placeholder**

```lua
--- Sprite identity cache, keyed by atlas rectangle.
---
--- Atlas rects are packed at RUNTIME and are not stable between sessions, so
--- they cannot be the id -- but within one session a rect is a fixed sprite, so
--- it is a sound cache key. This is what keeps the cost at one read per distinct
--- buff rather than sixty-four texture reads per buff per frame.
local spriteids = {}

--- How many points across the icon are sampled, per axis.
local SAMPLE_GRID = 8

--- FNV-1a, 32-bit.
local FNV_OFFSET = 2166136261
local FNV_PRIME = 16777619

--- Stable identity for a sprite-drawn buff, or nil if its pixels cannot be read.
---
--- SAMPLED ON A RELATIVE GRID, NOT AT FIXED OFFSETS. Interface scale changes the
--- size a sprite is stored at, and fixed offsets would then read different parts
--- of the same picture and hash to something else. Relative points at least read
--- CORRESPONDING parts.
---
--- QUANTISED TO THE TOP FOUR BITS per channel, so filtering and compression
--- noise -- a channel off by one or two -- cannot change the id.
---
--- This is the part of the design taken on trust rather than measured: whether
--- the atlas holds one variant per sprite or one per scale is not something the
--- draw stream has been read for yet. `M.identities` publishes the rect behind
--- each id so an id that moves when it should not is visible in the panel,
--- rather than being inferred later from an alert that quietly stopped firing.
local function spriteid(event, index)
  local ax, ay, aw, ah = event:vertexatlasdetails(index)
  if ax == nil or aw == nil or ah == nil or aw <= 0 or ah <= 0 then return nil end

  local rect = string.format("%d,%d,%d,%d", ax, ay, aw, ah)
  local cached = spriteids[rect]
  if cached ~= nil then return cached.id end

  local hash = FNV_OFFSET
  local read = 0
  for gy = 0, SAMPLE_GRID - 1 do
    for gx = 0, SAMPLE_GRID - 1 do
      local px = ax + math.floor((gx * aw) / SAMPLE_GRID)
      local py = ay + math.floor((gy * ah) / SAMPLE_GRID)
      local ok, texel = pcall(event.texturedata, event, px, py, 4)
      if ok and texel ~= nil and #texel >= 3 then
        read = read + 1
        for c = 1, 3 do
          local byte = string.byte(texel, c) // 16
          hash = (hash ~ byte) & 0xFFFFFFFF
          hash = (hash * FNV_PRIME) & 0xFFFFFFFF
        end
      end
    end
  end

  -- Nothing readable means no identity. Returning a hash of zero samples would
  -- give every unreadable sprite the SAME id, which is worse than none: two
  -- unrelated buffs would collide and an alert would follow whichever drew last.
  if read == 0 then return nil end

  local id = string.format("s:%08x", hash)
  spriteids[rect] = { id = id, atlas = rect, w = aw, h = ah }
  return id
end
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/lua/buffs.test.ts -t "two different ids"`
Expected: PASS

- [x] **Step 5: Prove the id is stable across ticks**

```ts
it("keeps a sprite's id the same across ticks", async () => {
  const plugin = await loadPlugin();
  const draw = () => spriteBuff({ at: { x: 1456, y: 990 }, texture: "stable-pattern", number: 60 });
  for (let i = 0; i < 3; i++) plugin.frame([draw()]);
  plugin.idle(1, TICK_US);
  const first = plugin.latest()?.buffs[0]?.id;
  for (let i = 0; i < 3; i++) plugin.frame([draw()]);
  plugin.idle(1, TICK_US);
  expect(plugin.latest()?.buffs[0]?.id).toBe(first);
  plugin.close();
});
```

- [x] **Step 6: Run the suite**

Run: `npm test`
Expected: all PASS

- [x] **Step 7: Commit**

```bash
git add lua/detect/buffs.lua tests/lua/buffs.test.ts
git commit -m "Identify a sprite-drawn buff by hashing its atlas pixels"
```

---

### Task 4: Carry bar position and source over the wire

**Files:**
- Modify: `src/bolt-io/protocol.ts` (`BuffSlotSchema`)
- Modify: `lua/detect/buffs.lua` (`M.request` — assign `slot`)
- Test: `tests/bolt-io/protocol.test.ts`, `tests/lua/buffs.test.ts`

**Interfaces:**
- Produces: `BuffSlot.slot: number` (1-based, left-to-right across buffs and debuffs together; 0 when unknown) and `BuffSlot.source: "icon" | "sprite" | "unknown"`.

- [x] **Step 1: Write the failing tests**

In `tests/lua/buffs.test.ts`:

```ts
it("numbers buffs left to right across the whole bar", async () => {
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([
      spriteBuff({ at: { x: 1546, y: 990 }, texture: "third", number: 10 }),
      spriteBuff({ at: { x: 1456, y: 990 }, texture: "first", number: 20 }),
      spriteBuff({ at: { x: 1516, y: 990 }, texture: "second", number: 30, isbuff: false }),
    ]);
  }
  plugin.idle(1, TICK_US);
  const state = plugin.latest();
  const bySlot = [...(state?.buffs ?? []), ...(state?.debuffs ?? [])].sort((a, b) => a.slot - b.slot);
  expect(bySlot.map((b) => b.slot)).toEqual([1, 2, 3]);
  expect(bySlot.map((b) => b.timeLeft)).toEqual([20, 30, 10]);
  expect(bySlot.map((b) => b.source)).toEqual(["sprite", "sprite", "sprite"]);
  plugin.close();
});
```

In `tests/bolt-io/protocol.test.ts`, add to the existing describe block:

```ts
it("defaults slot and source on a buff from an older plugin", () => {
  const decoded = BuffSlotSchema.parse({ id: "1:366" });
  expect(decoded.slot).toBe(0);
  expect(decoded.source).toBe("unknown");
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/lua/buffs.test.ts -t "left to right" tests/bolt-io/protocol.test.ts -t "older plugin"`
Expected: FAIL — `slot` and `source` do not exist.

- [x] **Step 3: Add the wire fields**

In `src/bolt-io/protocol.ts`, inside `BuffSlotSchema`, after `stacks`:

```ts
  /**
   * Position on the bar, left to right, 1-based. 0 when unknown.
   *
   * The picker's only way to tell two buffs apart. Ids are opaque by
   * construction -- a model signature or a pixel hash -- so "the third one
   * along" is the one description that matches what is on screen. Counted
   * across buffs and debuffs together, because they share the bar.
   */
  slot: z.number().int().nonnegative().default(0),
  /**
   * Which detection path found this buff.
   *
   * Published so the blind spot is measurable per buff rather than only in
   * aggregate: "icon" means Bolt recognised a rendered item model, "sprite"
   * means it was found by reading the draw stream directly.
   */
  source: z.enum(["icon", "sprite", "unknown"]).default("unknown"),
```

In `lua/detect/buffs.lua`, in `M.request()`, replace `buffs, debuffs = wipbuffs, wipdebuffs` with:

```lua
  -- Numbered across BOTH lists before publishing, because buffs and debuffs
  -- share one bar and the picker's "third along" has to mean third on screen,
  -- not third of its own kind.
  local ordered = {}
  for _, b in ipairs(wipbuffs) do ordered[#ordered + 1] = b end
  for _, b in ipairs(wipdebuffs) do ordered[#ordered + 1] = b end
  table.sort(ordered, function (a, b) return (a.x or 0) < (b.x or 0) end)
  for i, b in ipairs(ordered) do b.slot = i end

  buffs, debuffs = wipbuffs, wipdebuffs
```

- [x] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/lua/buffs.test.ts tests/bolt-io/protocol.test.ts`
Expected: PASS

- [x] **Step 5: Run the suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [x] **Step 6: Commit**

```bash
git add src/bolt-io/protocol.ts lua/detect/buffs.lua tests/lua/buffs.test.ts tests/bolt-io/protocol.test.ts
git commit -m "Number buffs by bar position and record which path found them"
```

---

### Task 5: Report the rect behind each sprite id

The spec calls the hash the unverified part of the design and requires it to say so. Without this the failure mode is an alert that silently stops matching after an interface-scale change.

**Files:**
- Modify: `lua/detect/buffs.lua` (add `M.identities`)
- Modify: `main.lua` (diag block)
- Modify: `src/bolt-io/protocol.ts` (`DiagnosticsSchema`)
- Test: `tests/lua/buffs.test.ts`

**Interfaces:**
- Produces: `M.identities()` returning a list of `{ id, atlas, w, h }`; `diag.buffIdentities` on the wire.

- [x] **Step 1: Write the failing test**

```ts
it("reports the atlas rect each sprite id was derived from", async () => {
  const plugin = await loadPlugin();
  for (let i = 0; i < 3; i++) {
    plugin.frame([spriteBuff({ at: { x: 1456, y: 990 }, texture: "traced", number: 60 })]);
  }
  plugin.idle(1, TICK_US);
  const ids = plugin.latest()?.diag.buffIdentities ?? [];
  expect(ids.length).toBe(1);
  expect(ids[0]?.id).toBe(plugin.latest()?.buffs[0]?.id);
  expect(ids[0]?.atlas).toBe("1456,0,27,27");
  expect(ids[0]?.w).toBe(27);
  plugin.close();
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/lua/buffs.test.ts -t "atlas rect each sprite"`
Expected: FAIL — `buffIdentities` is undefined.

- [x] **Step 3: Publish the identities**

In `lua/detect/buffs.lua`, add this **below** the `spriteids` table from Task 3 — a Lua local is not an upvalue of a function declared before it, so placing this above `spriteids` silently reads a global `nil` and returns an empty list forever:

```lua
--- Cap on identities reported. A bar holds well under this.
local MAX_IDENTITIES = 16

--- Every sprite id derived this session, with the atlas rect it came from.
---
--- THE HASH IS THE PART OF THIS DESIGN TAKEN ON TRUST. If the atlas holds a
--- separate variant per interface scale, an id will change when the user rescales
--- and every alert bound to it stops matching -- silently, because a buff that
--- cannot be found is indistinguishable from one that is not active. Publishing
--- the rect makes that visible in the panel in one glance instead.
function M.identities()
  local out = {}
  for _, entry in pairs(spriteids) do
    if #out >= MAX_IDENTITIES then break end
    out[#out + 1] = { id = entry.id, atlas = entry.atlas, w = entry.w, h = entry.h }
  end
  return out
end
```

In `main.lua`, inside the `diag` table, after `buffOutlines`:

```lua
    buffIdentities = buffs.identities(),
```

In `src/bolt-io/protocol.ts`, inside `DiagnosticsSchema`, after `buffOutlines`:

```ts
  /**
   * Sprite ids derived this session, with the atlas rectangle behind each.
   *
   * A sprite's identity is a hash of its pixels, because atlas rects are packed
   * at runtime and are not stable between sessions. Whether the atlas holds one
   * variant per sprite or one per interface scale has not been read out of a
   * live draw stream, so this is the reading that would show an id changing when
   * it should not -- which would otherwise surface only as an alert that quietly
   * stopped firing.
   */
  buffIdentities: z
    .array(
      z.object({
        id: z.string(),
        /** Atlas rectangle as "x,y,w,h". */
        atlas: z.string().default(""),
        w: z.number().default(0),
        h: z.number().default(0),
      }),
    )
    .default([]),
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/lua/buffs.test.ts -t "atlas rect each sprite"`
Expected: PASS

- [x] **Step 5: Run the suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [x] **Step 6: Commit**

```bash
git add lua/detect/buffs.lua main.lua src/bolt-io/protocol.ts tests/lua/buffs.test.ts
git commit -m "Report the atlas rect behind each sprite buff id"
```

---

### Task 6: Make the picker usable with a full bar, and show the split in the panel

**Files:**
- Modify: `src/ui/CapturePickers.tsx:95-106` (buff list) and `describeBuff`
- Modify: `src/ui/App.tsx` (`DetectionPanel` buff section)
- Test: `tests/ui/buff-picker.test.ts` (create)

**Interfaces:**
- Consumes: `BuffSlot.slot`, `BuffSlot.source`, `Diagnostics.buffIdentities`.
- Produces: `orderBuffsForPicker(buffs)` exported from `src/ui/CapturePickers.tsx`.

- [x] **Step 1: Write the failing test**

Create `tests/ui/buff-picker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orderBuffsForPicker } from "~/ui/CapturePickers";
import type { BuffSlot } from "~/bolt-io/protocol";

function slot(over: Partial<BuffSlot> & { id: string }): BuffSlot {
  return { timeLeft: null, stacks: null, slot: 0, source: "unknown", ...over };
}

describe("orderBuffsForPicker", () => {
  it("lists buffs in bar order, so the list matches the screen", () => {
    const ordered = orderBuffsForPicker([
      slot({ id: "c", slot: 3 }),
      slot({ id: "a", slot: 1 }),
      slot({ id: "b", slot: 2 }),
    ]);
    expect(ordered.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("puts unpositioned buffs last rather than first", () => {
    // slot 0 means "position unknown" -- an older plugin, or a buff whose x was
    // never read. Sorting numerically would float those to the top and claim
    // they are leftmost, which is the one thing the caller must not believe.
    const ordered = orderBuffsForPicker([slot({ id: "unknown", slot: 0 }), slot({ id: "first", slot: 1 })]);
    expect(ordered.map((b) => b.id)).toEqual(["first", "unknown"]);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/ui/buff-picker.test.ts`
Expected: FAIL — `orderBuffsForPicker` is not exported.

- [x] **Step 3: Implement and use it**

In `src/ui/CapturePickers.tsx`, above `BuffPicker`:

```tsx
/**
 * Buffs in the order they sit on the bar, left to right.
 *
 * Ids are opaque by construction, so position is the only handle a person has
 * on which entry is which. Slot 0 means the position is unknown, and those go
 * last: sorting them numerically would claim they are leftmost, which is a
 * confident answer to a question that has none.
 */
export function orderBuffsForPicker(buffs: readonly BuffSlot[]): BuffSlot[] {
  return [...buffs].sort((a, b) => {
    if (a.slot === 0 || b.slot === 0) return (a.slot === 0 ? 1 : 0) - (b.slot === 0 ? 1 : 0);
    return a.slot - b.slot;
  });
}
```

Replace the list body:

```tsx
        <ul class="issues">
          {orderBuffsForPicker(buffs).map((b) => (
            <li key={b.id}>
              <button class="btn btn--ghost" onClick={() => onPick(b.id)}>
                {b.slot > 0 ? `#${b.slot} on the bar — ` : ""}
                {describeBuff(b)}
                <span style="color: #888"> ({b.id})</span>
              </button>
            </li>
          ))}
        </ul>
```

Update the help text above it:

```tsx
      <p class="fld__help">
        Showing the {what}s active right now, in the order they sit on your bar — #1 is the
        leftmost. Apply the one you want to watch, then pick it here; it only needs to be active
        while you choose it, not afterwards. Name the alert itself to remember which is which.
      </p>
```

In `src/ui/App.tsx`, in the buff section of `DetectionPanel`, after the `Buffs on the bar` row:

```tsx
        <dt>Found via</dt>
        <dd>
          {buffs.concat(debuffs).length === 0
            ? "—"
            : `${buffs.concat(debuffs).filter((b) => b.source === "icon").length} as item models, ` +
              `${buffs.concat(debuffs).filter((b) => b.source === "sprite").length} as sprites`}
        </dd>
```

And after the unpaired list, add the identity readout:

```tsx
      {diag.buffIdentities.length > 0 ? (
        <>
          <p class="diag__note">
            Sprite buffs are identified by hashing their icon, because the game repacks its texture
            atlas each session. If an id here changes without the buff changing — after an interface
            rescale, say — alerts bound to it will stop matching, and this is where that shows.
          </p>
          <ul class="diag__list">
            {diag.buffIdentities.map((s) => (
              <li key={s.id}>
                {s.id} — atlas {s.atlas} ({s.w}×{s.h})
              </li>
            ))}
          </ul>
        </>
      ) : null}
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/ui/buff-picker.test.ts`
Expected: PASS

- [x] **Step 5: Run the suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all PASS

- [x] **Step 6: Commit**

```bash
git add src/ui/CapturePickers.tsx src/ui/App.tsx tests/ui/buff-picker.test.ts
git commit -m "Order the buff picker by bar position and show the detection split"
```

---

### Task 7: Update the file header and the README status

`lua/detect/buffs.lua`'s header states half the bar is unreachable and that closing the gap "is a design change, not a patch". After Task 3 that is no longer true, and a stale header is worse than none — the next person reads it as current.

**Files:**
- Modify: `lua/detect/buffs.lua:12-60` (header)
- Modify: `README.md` (status paragraph)
- Modify: `docs/superpowers/plans/2026-08-09-sprite-buff-detection.md` (tick the boxes)

- [x] **Step 1: Rewrite the blind-spot section of the header**

Replace the "HALF THIS BAR IS INVISIBLE" paragraph with:

```lua
-- TWO PATHS, BECAUSE BOLT ONLY ANNOUNCES SOME BUFFS.
--
-- onrendericon fires only for images Bolt recognised as a rendered item model:
-- its capture happens at the 64x64 item-icon render target, and an icon event is
-- split out of a batch only when a quad's atlas rect matches one it captured.
-- Potions, food and charged items qualify; abilities, prayers and familiars are
-- plain authored sprites and raise nothing at all. Half a measured bar was
-- unreachable for that reason alone.
--
-- So there is a second path, added 2026-08-09: the sprite pass at the bottom of
-- M.onrender2d offers the module any textured image drawn at an outline's exact
-- top-left. The two paths see DISJOINT sets -- Bolt removes a recognised
-- item-model quad from the batch to raise its icon event -- so both are needed
-- and neither is redundant.
--
-- Identity differs between them. An icon has a model signature; a sprite has
-- only its pixels, because atlas rects are packed at runtime and do not survive
-- a session. Sprite ids are therefore a hash of the icon, prefixed `s:`, and are
-- ADDITIVE: existing models:verts ids kept working and no config migration was
-- needed. See docs/superpowers/specs/2026-08-09-sprite-buff-detection-design.md.
```

- [x] **Step 2: Update the README**

In `## What's different`, replace the "Immutable buff templates" bullet's neighbours by adding this bullet after "All chatboxes monitored":

```markdown
- **The whole buff bar is read**, not the part of it the game announces. RuneScape tells a plugin
  about a buff only when its icon is a rendered item model — potions, food, charged items — and
  says nothing at all for abilities, prayers and familiars, which are drawn as plain sprites. Those
  are found by reading the draw stream directly, so an alert can watch any of them.
```

In `## Feature parity`, change the `buffs` row to:

```markdown
| `buffs` | ✅ item-model and sprite-drawn |
```

- [x] **Step 3: Verify and commit**

Run: `npm run ci`
Expected: typecheck, tests and build all PASS

```bash
git add lua/detect/buffs.lua README.md docs/superpowers/plans/2026-08-09-sprite-buff-detection.md
git commit -m "Record that the buff blind spot is closed"
```

---

## Verification in game

The suite cannot confirm the two facts that live outside it. After `npm run build` **and a plugin restart in Bolt**:

1. Open the detection panel. **Buffs on the bar** and buffs read should now agree — that difference was the blind spot.
2. **Found via** should show a non-zero sprite count with abilities or a familiar active.
3. Note a sprite id from the identity list, change interface scale, and look again. If the id changed, the hash is scale-sensitive: the fix is to sample the DRAWN quad rather than the atlas entry, and the rect readout is what will say so.
