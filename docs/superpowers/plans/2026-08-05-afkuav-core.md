# AFK Goblin Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build AFK Goblin's runtime core — self-healing readers, multi-chatbox monitoring, the alerter engine, and the AfkWarden importer — up to the point where the user's 15 real presets load and their chat and inactivity alerts fire reliably.

**Architecture:** A 600 ms tick loop takes exactly one screen capture and hands it to every reader. Readers sit behind a `ReaderAnchor` that owns screen position and invalidates it on geometry change, `rslinked`, consecutive empty reads, or TTL — the fix for AfkWarden's find-once-cache-forever defect. Alerter modules are pure data + a `check()` function over a shared context, so they are testable without Alt1.

**Tech Stack:** TypeScript 7 · Preact 10 · zod 4 · Vite 8 · `alt1` 0.1.3 · Vitest 4

## Global Constraints

- Build target is **`chrome108`**. Alt1 1.6.0 embeds CEF 108.4.13 (Chromium 108.0.5359.125). Never raise without re-checking the host.
- No CSS nesting, `oklch()`, `color-mix()`, subgrid, or popover API. Grid, `:has()`, container queries, `<dialog>` are available.
- localStorage keys are namespaced **`afkw2_*`**. Never reuse `afkscape_*` — origin is `(scheme, host, port)` and every Alt1 plugin on one `github.io` account shares one bucket.
- **Only one bound image per app.** Never hold an `ImgRefBind` across ticks: capture, `toData()`, release.
- Full-client capture at 1080p is 8.3 MB, above the 4,000,000-byte `maxtransfer`. Use `captureAsync` for snapshots; handle per-region `null` from `captureMultiAsync`.
- Nothing outside `src/alt1-io/` may import `alt1` directly.
- No network calls at runtime. Zero backend.
- The AfkWarden field `treshold` (sic) is preserved **only** in the import mapper; the internal model uses `threshold`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/alt1-io/geometry.ts` | `RsGeometry` snapshot + change detection (no resize event exists) |
| `src/alt1-io/capture.ts` | One capture per tick, shared by all readers |
| `src/alt1-io/overlay.ts` | Overlay rect/text, tooltip, taskbar |
| `src/alt1-io/events.ts` | Alt1 event subscription, permission checks |
| `src/readers/anchor.ts` | `ReaderAnchor` — position ownership + invalidation |
| `src/readers/chatbox-pool.ts` | N `ChatBoxReader`s, one per detected box |
| `src/readers/buff-match.ts` | Immutable-needle buff scoring |
| `src/engine/types.ts` | `AlerterModule`, `AlerterRuntime`, `AlerterContext` |
| `src/engine/registry.ts` | Alerter type registry |
| `src/engine/loop.ts` | 600 ms master tick |
| `src/alerters/*.ts` | One module per alerter type |
| `src/store/schema.ts` | zod models for preset/alerter/settings |
| `src/import/afkwarden.ts` | AfkWarden JSON → internal model |
| `tests/**` | Vitest |

---

## Task 1: RS geometry watch

**Files:**
- Create: `src/alt1-io/geometry.ts`
- Test: `tests/alt1-io/geometry.test.ts`

**Interfaces:**
- Produces: `type RsGeometry = { x: number; y: number; width: number; height: number; scaling: number }`, `function readGeometry(host: Alt1Host): RsGeometry | null`, `class GeometryWatch { constructor(host: Alt1Host); poll(): boolean; current: RsGeometry | null }`, `interface Alt1Host { rsX: number; rsY: number; rsWidth: number; rsHeight: number; rsScaling: number; rsLinked: boolean }`
- `poll()` returns `true` when geometry changed since the previous call.

`Alt1Host` exists so tests can inject a fake instead of the real `alt1` global. This is the seam that keeps everything downstream testable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { GeometryWatch, readGeometry, type Alt1Host } from "~/alt1-io/geometry";

function host(over: Partial<Alt1Host> = {}): Alt1Host {
  return { rsX: 0, rsY: 0, rsWidth: 1920, rsHeight: 1080, rsScaling: 1, rsLinked: true, ...over };
}

describe("readGeometry", () => {
  it("returns null when RS is not linked", () => {
    expect(readGeometry(host({ rsLinked: false }))).toBeNull();
  });

  it("snapshots the client rect", () => {
    expect(readGeometry(host())).toEqual({ x: 0, y: 0, width: 1920, height: 1080, scaling: 1 });
  });
});

describe("GeometryWatch", () => {
  it("reports change on first poll", () => {
    expect(new GeometryWatch(host()).poll()).toBe(true);
  });

  it("reports no change when geometry is stable", () => {
    const w = new GeometryWatch(host());
    w.poll();
    expect(w.poll()).toBe(false);
  });

  it("detects a resize", () => {
    const h = host();
    const w = new GeometryWatch(h);
    w.poll();
    h.rsWidth = 1280;
    expect(w.poll()).toBe(true);
  });

  it("detects a UI scale change without a size change", () => {
    const h = host();
    const w = new GeometryWatch(h);
    w.poll();
    h.rsScaling = 2;
    expect(w.poll()).toBe(true);
  });

  it("does NOT report change when only the window moves", () => {
    const h = host();
    const w = new GeometryWatch(h);
    w.poll();
    h.rsX = 400;
    h.rsY = 300;
    expect(w.poll()).toBe(false);
  });

  it("reports change when RS unlinks", () => {
    const h = host();
    const w = new GeometryWatch(h);
    w.poll();
    h.rsLinked = false;
    expect(w.poll()).toBe(true);
  });
});
```

The move-does-not-invalidate case matters: reader coordinates are RS-client-relative, so moving the window is free. Invalidating on move would cause pointless re-finds.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/alt1-io/geometry.test.ts`
Expected: FAIL — cannot resolve `~/alt1-io/geometry`

- [ ] **Step 3: Write minimal implementation**

```ts
export interface Alt1Host {
  rsX: number;
  rsY: number;
  rsWidth: number;
  rsHeight: number;
  rsScaling: number;
  rsLinked: boolean;
}

export type RsGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  scaling: number;
};

export function readGeometry(host: Alt1Host): RsGeometry | null {
  if (!host.rsLinked) return null;
  return {
    x: host.rsX,
    y: host.rsY,
    width: host.rsWidth,
    height: host.rsHeight,
    scaling: host.rsScaling,
  };
}

/**
 * Alt1 has no resize event — its nine event types are alt1pressed, menudetected,
 * rslinked, rsunlinked, permissionchanged, daemonrun, userevent, rsfocus, rsblur.
 * Resize and UI-scale changes are therefore only detectable by polling.
 *
 * Position (x/y) is deliberately excluded: reader coordinates are client-relative,
 * so a moved window needs no re-find.
 */
export class GeometryWatch {
  current: RsGeometry | null = null;
  #seen = false;

  constructor(private readonly host: Alt1Host) {}

  poll(): boolean {
    const next = readGeometry(this.host);
    const changed =
      !this.#seen ||
      (next === null) !== (this.current === null) ||
      (next !== null &&
        this.current !== null &&
        (next.width !== this.current.width ||
          next.height !== this.current.height ||
          next.scaling !== this.current.scaling));
    this.#seen = true;
    this.current = next;
    return changed;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/alt1-io/geometry.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/alt1-io/geometry.ts tests/alt1-io/geometry.test.ts
git commit -m "Add RS geometry watch for reader invalidation"
```

---

## Task 2: ReaderAnchor

This is the fix for root cause §3.1. It is the most important file in the project.

**Files:**
- Create: `src/readers/anchor.ts`
- Test: `tests/readers/anchor.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately decoupled from `GeometryWatch`; the loop wires them together)
- Produces:
```ts
type AnchorState = "searching" | "ok" | "lost";
type AnchorHealth = {
  state: AnchorState;
  foundAtTick: number | null;
  emptyReads: number;
  findAttempts: number;
  lastInvalidation: string | null;
};
class ReaderAnchor<T> {
  constructor(opts: {
    find: () => T | null;
    ttlTicks?: number;      // default 500 (~5 min at 600ms)
    maxEmptyReads?: number; // default 10
  });
  get(tick: number): T | null;
  reportRead(producedData: boolean): void;
  invalidate(reason: string): void;
  readonly health: AnchorHealth;
}
```

`get()` must attempt at most one `find()` per tick — repeated find attempts on a missing target would tank the frame budget.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { ReaderAnchor } from "~/readers/anchor";

describe("ReaderAnchor", () => {
  it("finds lazily and caches within a session", () => {
    const find = vi.fn(() => ({ box: 1 }));
    const a = new ReaderAnchor({ find });
    expect(a.get(1)).toEqual({ box: 1 });
    expect(a.get(2)).toEqual({ box: 1 });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("attempts find at most once per tick when the target is absent", () => {
    const find = vi.fn(() => null);
    const a = new ReaderAnchor({ find });
    a.get(1);
    a.get(1);
    a.get(1);
    expect(find).toHaveBeenCalledTimes(1);
    a.get(2);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("re-finds after explicit invalidation", () => {
    const find = vi.fn(() => ({ box: 1 }));
    const a = new ReaderAnchor({ find });
    a.get(1);
    a.invalidate("resize");
    a.get(2);
    expect(find).toHaveBeenCalledTimes(2);
    expect(a.health.lastInvalidation).toBe("resize");
  });

  // The core regression test for AfkWarden's defect.
  it("self-heals after consecutive empty reads", () => {
    const find = vi.fn(() => ({ box: 1 }));
    const a = new ReaderAnchor({ find, maxEmptyReads: 3 });
    a.get(1);
    for (let i = 0; i < 3; i++) a.reportRead(false);
    a.get(2);
    expect(find).toHaveBeenCalledTimes(2);
    expect(a.health.lastInvalidation).toBe("empty-reads");
  });

  it("resets the empty-read counter on a successful read", () => {
    const find = vi.fn(() => ({ box: 1 }));
    const a = new ReaderAnchor({ find, maxEmptyReads: 3 });
    a.get(1);
    a.reportRead(false);
    a.reportRead(false);
    a.reportRead(true);
    a.reportRead(false);
    a.get(2);
    expect(find).toHaveBeenCalledTimes(1);
    expect(a.health.emptyReads).toBe(1);
  });

  it("re-finds after the TTL expires", () => {
    const find = vi.fn(() => ({ box: 1 }));
    const a = new ReaderAnchor({ find, ttlTicks: 10 });
    a.get(1);
    a.get(5);
    expect(find).toHaveBeenCalledTimes(1);
    a.get(12);
    expect(find).toHaveBeenCalledTimes(2);
    expect(a.health.lastInvalidation).toBe("ttl");
  });

  it("reports health transitions", () => {
    let found: { box: number } | null = null;
    const a = new ReaderAnchor({ find: () => found });
    expect(a.health.state).toBe("searching");
    a.get(1);
    expect(a.health.state).toBe("lost");
    found = { box: 1 };
    a.get(2);
    expect(a.health.state).toBe("ok");
    expect(a.health.foundAtTick).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/readers/anchor.test.ts`
Expected: FAIL — cannot resolve `~/readers/anchor`

- [ ] **Step 3: Write minimal implementation**

```ts
export type AnchorState = "searching" | "ok" | "lost";

export type AnchorHealth = {
  state: AnchorState;
  foundAtTick: number | null;
  emptyReads: number;
  findAttempts: number;
  lastInvalidation: string | null;
};

export type ReaderAnchorOptions<T> = {
  find: () => T | null;
  ttlTicks?: number;
  maxEmptyReads?: number;
};

/**
 * Owns a reader's screen position and decides when it is stale.
 *
 * AfkWarden caches reader positions for the whole session with no invalidation
 * path -- `if (reader.pos) return;` and nothing ever clears `.pos`. Any resize or
 * UI-scale change afterwards leaves every dependent alert reading the wrong
 * rectangle silently, forever. This class exists to make that failure impossible:
 * a position is a lease, not a fact.
 */
export class ReaderAnchor<T> {
  #pos: T | null = null;
  #foundAtTick: number | null = null;
  #lastAttemptTick = -1;
  #emptyReads = 0;
  #findAttempts = 0;
  #lastInvalidation: string | null = null;
  #state: AnchorState = "searching";

  readonly #find: () => T | null;
  readonly #ttlTicks: number;
  readonly #maxEmptyReads: number;

  constructor(opts: ReaderAnchorOptions<T>) {
    this.#find = opts.find;
    this.#ttlTicks = opts.ttlTicks ?? 500;
    this.#maxEmptyReads = opts.maxEmptyReads ?? 10;
  }

  get health(): AnchorHealth {
    return {
      state: this.#state,
      foundAtTick: this.#foundAtTick,
      emptyReads: this.#emptyReads,
      findAttempts: this.#findAttempts,
      lastInvalidation: this.#lastInvalidation,
    };
  }

  invalidate(reason: string): void {
    if (this.#pos !== null) this.#lastInvalidation = reason;
    this.#pos = null;
    this.#foundAtTick = null;
    this.#emptyReads = 0;
  }

  reportRead(producedData: boolean): void {
    if (producedData) {
      this.#emptyReads = 0;
      return;
    }
    this.#emptyReads++;
    if (this.#emptyReads >= this.#maxEmptyReads) {
      this.invalidate("empty-reads");
    }
  }

  get(tick: number): T | null {
    if (
      this.#pos !== null &&
      this.#foundAtTick !== null &&
      tick - this.#foundAtTick >= this.#ttlTicks
    ) {
      this.invalidate("ttl");
    }

    if (this.#pos !== null) return this.#pos;

    // At most one find attempt per tick: a missing target must not burn the budget.
    if (tick === this.#lastAttemptTick) return null;
    this.#lastAttemptTick = tick;
    this.#findAttempts++;

    const found = this.#find();
    if (found === null) {
      this.#state = "lost";
      return null;
    }
    this.#pos = found;
    this.#foundAtTick = tick;
    this.#state = "ok";
    return found;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/readers/anchor.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/readers/anchor.ts tests/readers/anchor.test.ts
git commit -m "Add ReaderAnchor with position invalidation"
```

---

## Task 3: Buff needle scoring

Fix for root cause §3.2. AfkWarden's `matchBuffMulti` requires 50 absolute matching pixels and re-masks the template on every match (`isolateBuffer`), a ratchet that only removes pixels. Real templates measured at 53 opaque pixels — three above the floor.

**Files:**
- Create: `src/readers/buff-match.ts`
- Test: `tests/readers/buff-match.test.ts`

**Interfaces:**
- Produces:
```ts
type Needle = { width: number; height: number; data: Uint8ClampedArray };  // RGBA
type MatchResult = { score: number; matched: number; comparable: number };
function scoreNeedle(needle: Needle, hay: Needle): MatchResult;
function coverage(needle: Needle): number;      // opaque px count
function isLowCoverage(needle: Needle): boolean; // < 60 opaque px
const MIN_COMPARABLE_PIXELS = 24;
const MATCH_THRESHOLD = 0.85;
```

`score` is **matched / comparable** — a fraction of the needle's own opaque pixels, so a sparse template is not structurally disadvantaged the way an absolute floor makes it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  coverage,
  isLowCoverage,
  scoreNeedle,
  MATCH_THRESHOLD,
  type Needle,
} from "~/readers/buff-match";

function make(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Needle {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

const solid = (r: number, g: number, b: number) => () => [r, g, b, 255] as [number, number, number, number];

describe("coverage", () => {
  it("counts only fully opaque pixels", () => {
    expect(coverage(make(4, 4, solid(1, 2, 3)))).toBe(16);
    expect(coverage(make(4, 4, () => [1, 2, 3, 0]))).toBe(0);
  });

  it("flags sparse needles", () => {
    // 53 opaque px is the real Overload-timer measurement: 3 above AfkWarden's floor of 50.
    const sparse = make(25, 25, (x, y) => (y * 25 + x < 53 ? [9, 9, 9, 255] : [0, 0, 0, 0]));
    expect(coverage(sparse)).toBe(53);
    expect(isLowCoverage(sparse)).toBe(true);
  });
});

describe("scoreNeedle", () => {
  it("scores an exact match as 1", () => {
    const n = make(5, 5, solid(10, 20, 30));
    expect(scoreNeedle(n, make(5, 5, solid(10, 20, 30))).score).toBe(1);
  });

  it("scores a total mismatch as 0", () => {
    const n = make(5, 5, solid(10, 20, 30));
    expect(scoreNeedle(n, make(5, 5, solid(200, 200, 200))).score).toBe(0);
  });

  it("ignores transparent needle pixels", () => {
    // Only the left column is opaque; the rest of the haystack differs wildly.
    const n = make(4, 4, (x) => (x === 0 ? [10, 20, 30, 255] : [0, 0, 0, 0]));
    const hay = make(4, 4, (x) => (x === 0 ? [10, 20, 30, 255] : [255, 0, 0, 255]));
    const r = scoreNeedle(n, hay);
    expect(r.comparable).toBe(4);
    expect(r.score).toBe(1);
  });

  it("does not disadvantage a sparse needle -- the AfkWarden regression", () => {
    // 53 opaque px matching perfectly must pass, where an absolute floor of 50
    // leaves only 3 pixels of headroom before silent permanent failure.
    const sparse = make(25, 25, (x, y) => (y * 25 + x < 53 ? [7, 7, 7, 255] : [0, 0, 0, 0]));
    const hay = make(25, 25, solid(7, 7, 7));
    const r = scoreNeedle(sparse, hay);
    expect(r.comparable).toBe(53);
    expect(r.score).toBe(1);
    expect(r.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("returns score 0 when too few pixels are comparable to be meaningful", () => {
    const tiny = make(25, 25, (x, y) => (y * 25 + x < 5 ? [7, 7, 7, 255] : [0, 0, 0, 0]));
    expect(scoreNeedle(tiny, make(25, 25, solid(7, 7, 7))).score).toBe(0);
  });

  it("returns score 0 on a size mismatch", () => {
    expect(scoreNeedle(make(5, 5, solid(1, 1, 1)), make(6, 6, solid(1, 1, 1))).score).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/readers/buff-match.test.ts`
Expected: FAIL — cannot resolve `~/readers/buff-match`

- [ ] **Step 3: Write minimal implementation**

```ts
export type Needle = { width: number; height: number; data: Uint8ClampedArray };
export type MatchResult = { score: number; matched: number; comparable: number };

/** Below this many opaque pixels a template carries too little signal to trust. */
export const MIN_COMPARABLE_PIXELS = 24;
export const MATCH_THRESHOLD = 0.85;
export const LOW_COVERAGE_PIXELS = 60;

/** Per-channel tolerance; RS icons are alpha-blended so exact equality is too strict. */
const CHANNEL_TOLERANCE = 24;

export function coverage(needle: Needle): number {
  let n = 0;
  for (let i = 3; i < needle.data.length; i += 4) {
    if (needle.data[i] === 255) n++;
  }
  return n;
}

export function isLowCoverage(needle: Needle): boolean {
  return coverage(needle) < LOW_COVERAGE_PIXELS;
}

/**
 * Score `hay` against `needle` as the FRACTION of the needle's own opaque pixels
 * that match.
 *
 * AfkWarden scores with an absolute floor (`if (bestscore < 50) return null`) while
 * simultaneously eroding templates on every match. A sparse template is therefore
 * punished twice: it has fewer pixels to offer, and it keeps losing more. Scoring
 * relatively removes the first problem; keeping needles immutable removes the second.
 */
export function scoreNeedle(needle: Needle, hay: Needle): MatchResult {
  if (needle.width !== hay.width || needle.height !== hay.height) {
    return { score: 0, matched: 0, comparable: 0 };
  }

  let matched = 0;
  let comparable = 0;
  for (let i = 0; i < needle.data.length; i += 4) {
    if (needle.data[i + 3] !== 255) continue;
    comparable++;
    if (
      Math.abs(needle.data[i]! - hay.data[i]!) <= CHANNEL_TOLERANCE &&
      Math.abs(needle.data[i + 1]! - hay.data[i + 1]!) <= CHANNEL_TOLERANCE &&
      Math.abs(needle.data[i + 2]! - hay.data[i + 2]!) <= CHANNEL_TOLERANCE
    ) {
      matched++;
    }
  }

  if (comparable < MIN_COMPARABLE_PIXELS) {
    return { score: 0, matched, comparable };
  }
  return { score: matched / comparable, matched, comparable };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/readers/buff-match.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/readers/buff-match.ts tests/readers/buff-match.test.ts
git commit -m "Add relative-coverage buff needle scoring"
```

---

## Task 4: Store schema

**Files:**
- Create: `src/store/schema.ts`
- Test: `tests/store/schema.test.ts`

**Interfaces:**
- Produces: `AlarmSchema`, `VoiceSchema`, `AlerterBaseSchema`, `PresetSchema`, `SettingsSchema` and inferred types `Alarm`, `Voice`, `AlerterBase`, `Preset`, `Settings`; `DEFAULT_SETTINGS: Settings`.

Alerter field names are the internal ones (`threshold`, not `treshold`). `type` is a plain string here; per-type field validation lives with each alerter module and is composed in Task 8.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { AlerterBaseSchema, DEFAULT_SETTINGS, PresetSchema, SettingsSchema } from "~/store/schema";

describe("AlerterBaseSchema", () => {
  it("accepts a minimal alerter and applies defaults", () => {
    const r = AlerterBaseSchema.parse({ name: "Lobby timer", type: "inactive" });
    expect(r.globalalarm).toBe(true);
    expect(r.alarm).toBeNull();
    expect(r.voice).toBeNull();
    expect(r.tooltip).toBeNull();
    expect(r.exportbar).toBe(false);
    expect(r.paused).toBe(false);
    expect(r.group).toBeNull();
  });

  it("rejects an alerter with no type", () => {
    expect(() => AlerterBaseSchema.parse({ name: "x" })).toThrow();
  });

  it("accepts an alarm with a repeat flag", () => {
    const r = AlerterBaseSchema.parse({
      name: "x", type: "chat", alarm: { sound: "elevator", repeat: true },
    });
    expect(r.alarm).toEqual({ sound: "elevator", repeat: true });
  });

  it("accepts a voice spec within bounds and rejects out of range", () => {
    expect(
      AlerterBaseSchema.parse({ name: "x", type: "chat", voice: { text: "hi", speed: 175, pitch: 50 } }).voice,
    ).toEqual({ text: "hi", speed: 175, pitch: 50 });
    expect(() =>
      AlerterBaseSchema.parse({ name: "x", type: "chat", voice: { text: "hi", speed: 9999, pitch: 50 } }),
    ).toThrow();
  });
});

describe("PresetSchema", () => {
  it("round-trips a preset", () => {
    const r = PresetSchema.parse({
      name: "Mining",
      alerters: [{ name: "Lobby timer", type: "inactive" }],
    });
    expect(r.name).toBe("Mining");
    expect(r.alerters).toHaveLength(1);
    expect(r.groups).toEqual([]);
  });

  it("rejects an unnamed preset", () => {
    expect(() => PresetSchema.parse({ name: "", alerters: [] })).toThrow();
  });
});

describe("SettingsSchema", () => {
  it("has usable defaults", () => {
    const s = SettingsSchema.parse({});
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.volume).toBeGreaterThan(0);
    expect(s.muted).toBe(false);
  });

  it("clamps volume to 0..1", () => {
    expect(() => SettingsSchema.parse({ volume: 1.5 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/schema.test.ts`
Expected: FAIL — cannot resolve `~/store/schema`

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from "zod";

export const AlarmSchema = z.object({
  sound: z.string().min(1),
  repeat: z.boolean().default(false),
});

export const VoiceSchema = z.object({
  text: z.string(),
  speed: z.number().min(50).max(500).default(175),
  pitch: z.number().min(0).max(100).default(50),
});

export const AlerterBaseSchema = z.object({
  name: z.string(),
  type: z.string().min(1),
  globalalarm: z.boolean().default(true),
  alarm: AlarmSchema.nullable().default(null),
  voice: VoiceSchema.nullable().default(null),
  tooltip: z.string().nullable().default(null),
  exportbar: z.boolean().default(false),
  paused: z.boolean().default(false),
  /** Section header this alerter belongs to. Replaces AfkWarden's empty-alerter workaround. */
  group: z.string().nullable().default(null),
  vars: z.record(z.string(), z.unknown()).default({}),
});

export const PresetSchema = z.object({
  name: z.string().min(1),
  baseName: z.string().default(""),
  groups: z.array(z.string()).default([]),
  alerters: z.array(AlerterBaseSchema).default([]),
});

export const SettingsSchema = z.object({
  activeSuppress: z.boolean().default(false),
  globalAlarm: AlarmSchema.nullable().default({ sound: "elevator", repeat: false }),
  showTaskbarOverlay: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(0.5),
  muted: z.boolean().default(false),
});

export type Alarm = z.infer<typeof AlarmSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type AlerterBase = z.infer<typeof AlerterBaseSchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/schema.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store/schema.ts tests/store/schema.test.ts
git commit -m "Add zod schema for presets, alerters and settings"
```

---

## Task 5: AfkWarden importer

**Files:**
- Create: `src/import/afkwarden.ts`
- Test: `tests/import/afkwarden.test.ts`

**Interfaces:**
- Consumes: `Preset`, `PresetSchema` from `~/store/schema`
- Produces:
```ts
type ImportIssue = { path: string; message: string };
type ImportResult =
  | { ok: true; presets: Preset[]; issues: ImportIssue[] }
  | { ok: false; issues: ImportIssue[] };
function importAfkWarden(raw: unknown): ImportResult;
function importAfkWardenJson(text: string): ImportResult;
```

Accepts three real shapes: a single exported preset `{alerters, name, baseName}`, the whole `afkscape_presets` map `{ [name]: preset }`, and an array of presets. Unknown alerter types are **kept** with an issue recorded rather than dropped — silently losing an alert is the failure mode being designed out.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { importAfkWarden, importAfkWardenJson } from "~/import/afkwarden";

const chatAlerter = {
  name: "Seren spirit",
  globalalarm: true,
  alarm: null,
  voice: null,
  tooltip: null,
  exportbar: false,
  resetonactive: true,
  lines: [{ text: "A Seren spirit appears", percent: 100 }],
  colors: [[0, 255, 255]],
  type: "chat",
};

describe("importAfkWarden", () => {
  it("imports a single exported preset", () => {
    const r = importAfkWarden({ name: "Woodcutting", baseName: "woodcutting", alerters: [chatAlerter] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presets).toHaveLength(1);
    expect(r.presets[0]!.name).toBe("Woodcutting");
    expect(r.presets[0]!.alerters[0]!.type).toBe("chat");
  });

  it("imports the whole afkscape_presets map", () => {
    const r = importAfkWarden({
      Mining: { name: "Mining", baseName: "mining", alerters: [] },
      Woodcutting: { name: "Woodcutting", baseName: "woodcutting", alerters: [chatAlerter] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presets.map((p) => p.name).sort()).toEqual(["Mining", "Woodcutting"]);
  });

  it("renames treshold to threshold", () => {
    const r = importAfkWarden({
      name: "P", alerters: [{ name: "HP", type: "actionbar", stat: "hp", higherlower: "lower", treshold: 30 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presets[0]!.alerters[0]!.vars.threshold).toBe(30);
    expect(r.presets[0]!.alerters[0]!.vars.treshold).toBeUndefined();
  });

  it("moves type-specific fields into vars and keeps common fields at the top", () => {
    const r = importAfkWarden({ name: "P", alerters: [chatAlerter] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.presets[0]!.alerters[0]!;
    expect(a.name).toBe("Seren spirit");
    expect(a.globalalarm).toBe(true);
    expect(a.vars.lines).toEqual([{ text: "A Seren spirit appears", percent: 100 }]);
    expect(a.vars.colors).toEqual([[0, 255, 255]]);
    expect(a.vars.name).toBeUndefined();
  });

  it("converts an empty-named alerter with no lines into a group header", () => {
    const r = importAfkWarden({
      name: "Zuk",
      alerters: [
        { name: "Pause all the below if using Elder Overload", type: "chat", lines: [], colors: [] },
        chatAlerter,
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.presets[0]!;
    expect(p.groups).toContain("Pause all the below if using Elder Overload");
    expect(p.alerters).toHaveLength(1);
    expect(p.alerters[0]!.group).toBe("Pause all the below if using Elder Overload");
  });

  it("keeps an unknown alerter type and records an issue", () => {
    const r = importAfkWarden({ name: "P", alerters: [{ name: "Odd", type: "notarealtype" }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presets[0]!.alerters).toHaveLength(1);
    expect(r.issues.some((i) => i.message.includes("notarealtype"))).toBe(true);
  });

  it("fails visibly on malformed input instead of silently", () => {
    expect(importAfkWarden(null).ok).toBe(false);
    expect(importAfkWarden(42).ok).toBe(false);
    const r = importAfkWardenJson("{ not json");
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/parse/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import/afkwarden.test.ts`
Expected: FAIL — cannot resolve `~/import/afkwarden`

- [ ] **Step 3: Write minimal implementation**

```ts
import { PresetSchema, type Preset } from "~/store/schema";
import { KNOWN_ALERTER_TYPES } from "~/engine/known-types";

export type ImportIssue = { path: string; message: string };
export type ImportResult =
  | { ok: true; presets: Preset[]; issues: ImportIssue[] }
  | { ok: false; issues: ImportIssue[] };

/** Fields AfkWarden stores on every alerter regardless of type. */
const COMMON_FIELDS = new Set([
  "name", "type", "globalalarm", "alarm", "voice", "tooltip", "exportbar",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikePreset(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && Array.isArray(v.alerters);
}

export function importAfkWardenJson(text: string): ImportResult {
  try {
    return importAfkWarden(JSON.parse(text));
  } catch (e) {
    return { ok: false, issues: [{ path: "$", message: `Could not parse JSON: ${(e as Error).message}` }] };
  }
}

export function importAfkWarden(raw: unknown): ImportResult {
  const issues: ImportIssue[] = [];

  let candidates: Array<{ key: string; value: unknown }>;
  if (looksLikePreset(raw)) {
    candidates = [{ key: String(raw.name ?? "Imported"), value: raw }];
  } else if (Array.isArray(raw)) {
    candidates = raw.map((v, i) => ({ key: `[${i}]`, value: v }));
  } else if (isRecord(raw)) {
    candidates = Object.entries(raw).map(([key, value]) => ({ key, value }));
  } else {
    return { ok: false, issues: [{ path: "$", message: "Expected a preset object, a preset map, or an array." }] };
  }

  const presets: Preset[] = [];
  for (const { key, value } of candidates) {
    if (!looksLikePreset(value)) {
      issues.push({ path: key, message: "Not a preset (no alerters array); skipped." });
      continue;
    }
    presets.push(convertPreset(key, value, issues));
  }

  if (presets.length === 0) {
    issues.push({ path: "$", message: "No presets found in the supplied data." });
    return { ok: false, issues };
  }
  return { ok: true, presets, issues };
}

function convertPreset(key: string, src: Record<string, unknown>, issues: ImportIssue[]): Preset {
  const name = typeof src.name === "string" && src.name.length > 0 ? src.name : key;
  const groups: string[] = [];
  const alerters: unknown[] = [];
  let currentGroup: string | null = null;

  for (const [i, rawAlerter] of (src.alerters as unknown[]).entries()) {
    const path = `${name}.alerters[${i}]`;
    if (!isRecord(rawAlerter)) {
      issues.push({ path, message: "Alerter is not an object; skipped." });
      continue;
    }

    // AfkWarden has no grouping, so users create chat alerters with no match lines
    // purely as section headers. Promote those to real groups.
    const lines = rawAlerter.lines;
    const isHeader =
      rawAlerter.type === "chat" && Array.isArray(lines) && lines.length === 0;
    if (isHeader) {
      const label = String(rawAlerter.name ?? "").trim();
      if (label.length > 0) {
        currentGroup = label;
        if (!groups.includes(label)) groups.push(label);
      } else {
        currentGroup = null;
      }
      continue;
    }

    const type = String(rawAlerter.type ?? "");
    if (!KNOWN_ALERTER_TYPES.has(type)) {
      issues.push({ path, message: `Unknown alerter type "${type}" kept as-is; it will not run until supported.` });
    }

    const vars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawAlerter)) {
      if (COMMON_FIELDS.has(k)) continue;
      // AfkWarden ships this misspelling; normalise on the way in and never re-emit it.
      vars[k === "treshold" ? "threshold" : k] = v;
    }

    alerters.push({
      name: String(rawAlerter.name ?? ""),
      type,
      globalalarm: rawAlerter.globalalarm ?? true,
      alarm: rawAlerter.alarm ?? null,
      voice: rawAlerter.voice ?? null,
      tooltip: rawAlerter.tooltip ?? null,
      exportbar: rawAlerter.exportbar ?? false,
      group: currentGroup,
      vars,
    });
  }

  return PresetSchema.parse({
    name,
    baseName: typeof src.baseName === "string" ? src.baseName : "",
    groups,
    alerters,
  });
}
```

Also create `src/engine/known-types.ts`:

```ts
/** The 16 alerter types AfkWarden actually registers (Alerter.ts:972-992). */
export const KNOWN_ALERTER_TYPES = new Set([
  "inactive", "xpcounter", "bigxp", "chat", "craftmenu", "drops", "buffs",
  "actionbar", "sheathe", "castlewars", "dialogtextsimple", "fightkiln",
  "targetdeath", "summoning", "clockbased", "necroritual",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/import/afkwarden.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/import/afkwarden.ts src/engine/known-types.ts tests/import/afkwarden.test.ts
git commit -m "Add AfkWarden config importer"
```

---

## Task 6: Import the real 15-preset config

Proves the importer against real data rather than fixtures written to match the implementation.

**Files:**
- Create: `tests/import/real-config.test.ts`
- Uses: `fixtures/personal/afkscape_presets.json` (gitignored; skip when absent)

- [ ] **Step 1: Write the test**

```ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importAfkWarden } from "~/import/afkwarden";

const path = fileURLToPath(new URL("../../fixtures/personal/afkscape_presets.json", import.meta.url));
const describeIfPresent = existsSync(path) ? describe : describe.skip;

describeIfPresent("real AfkWarden config", () => {
  const raw = JSON.parse(readFileSync(path, "utf8"));

  it("imports every preset", () => {
    const r = importAfkWarden(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.presets).toHaveLength(15);
  });

  it("recognises every alerter type present", () => {
    const r = importAfkWarden(raw);
    if (!r.ok) throw new Error("import failed");
    const unknown = r.issues.filter((i) => i.message.includes("Unknown alerter type"));
    expect(unknown).toEqual([]);
  });

  it("promotes the header alerters to groups", () => {
    const r = importAfkWarden(raw);
    if (!r.ok) throw new Error("import failed");
    const zuk = r.presets.find((p) => p.name === "Zuk");
    expect(zuk).toBeDefined();
    expect(zuk!.groups.length).toBeGreaterThan(0);
  });

  it("preserves the chat alerter count", () => {
    const r = importAfkWarden(raw);
    if (!r.ok) throw new Error("import failed");
    const chat = r.presets.flatMap((p) => p.alerters).filter((a) => a.type === "chat");
    // 74 chat alerters, minus the 3 empty ones promoted to group headers.
    expect(chat).toHaveLength(71);
  });
});
```

- [ ] **Step 2: Run and iterate until green**

Run: `npx vitest run tests/import/real-config.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/import/real-config.test.ts
git commit -m "Verify importer against the real 15-preset config"
```

---

## Task 7: Alerter module contract

**Files:**
- Create: `src/engine/types.ts`
- Test: `tests/engine/types.test.ts`

**Interfaces:**
- Produces:
```ts
type TriggerState = { triggered: boolean; bar: number; functional: boolean };
interface AlerterContext {
  tick: number;
  now: number;
  rsLastActive: number;
  chatLines: ReadonlyArray<{ text: string; color: [number, number, number]; fragments: string[] }>;
  geometry: RsGeometry | null;
}
interface AlerterRuntime { check(ctx: AlerterContext): TriggerState }
interface AlerterModule<TVars> {
  type: string;
  typename: string;
  descr: string;
  schema: ZodType<TVars>;
  create(vars: TVars): AlerterRuntime;
}
function defineAlerter<TVars>(m: AlerterModule<TVars>): AlerterModule<TVars>;
```

`check()` returning state (rather than mutating `this`) is what makes every alerter testable as a pure function of context.

- [ ] **Step 1–5:** Write a test asserting `defineAlerter` returns its argument unchanged and that a trivial module's `check()` is callable with a synthetic context; implement; run; commit.

```bash
git commit -m "Add alerter module contract"
```

---

## Task 8: `inactive` and `chat` alerters

The two that matter first: together they cover 87 of the user's 108 alerters.

**Files:**
- Create: `src/alerters/inactive.ts`, `src/alerters/chat.ts`
- Test: `tests/alerters/inactive.test.ts`, `tests/alerters/chat.test.ts`

**Interfaces:**
- Consumes: `defineAlerter`, `AlerterContext` from `~/engine/types`
- Produces: `inactiveAlerter`, `chatAlerter` — both `AlerterModule<…>`

`inactive` vars: `{ delay: number }` (seconds). Triggers when `now - rsLastActive >= delay*1000`; `bar` is progress toward that.

`chat` vars: `{ lines: {text, percent}[]; colors: [number,number,number][]; resetonactive: boolean }`. Triggers when any context chat line contains any `lines[].text` (case-insensitive substring, matching AfkWarden's semantics) and, when `colors` is non-empty, the line colour is in the set.

- [ ] **Step 1:** Write failing tests covering: inactive not triggering before the delay, triggering at it, `bar` clamped to 1; chat matching a substring, respecting the colour filter, ignoring non-matching colours, resetting on activity when `resetonactive`, and multi-line OR semantics.
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** Run — expect pass.
- [ ] **Step 5:** Commit.

```bash
git commit -m "Add inactive and chat alerters"
```

---

## Task 9: ChatboxPool

**Files:**
- Create: `src/readers/chatbox-pool.ts`
- Test: `tests/readers/chatbox-pool.test.ts`

**Interfaces:**
- Consumes: `ReaderAnchor`
- Produces:
```ts
interface ChatboxLike {
  find(img: unknown): { mainbox: unknown; boxes: unknown[] } | null;
  read(img: unknown): Array<{ text: string; color: [number,number,number]; fragments: string[] }> | null;
  pos: { mainbox: unknown; boxes: unknown[] } | null;
  readargs: { colors: number[] };
}
class ChatboxPool {
  constructor(opts: { makeReader: () => ChatboxLike; anchor?: ReaderAnchor<unknown> });
  update(tick: number, img: unknown, colors: number[]): ChatLine[];
  readonly boxCount: number;
  readonly health: AnchorHealth;
}
```

`makeReader` is injected so tests supply fakes and never touch Alt1.

Behaviour to test: one reader per detected box; the same line appearing in two boxes is emitted once; `readargs.colors` is re-set on **every** update (never cached); the pool re-syncs when box count changes; designation is re-applied after every `find()` because `find()` reassigns `pos`; empty reads feed the anchor.

- [ ] **Step 1–5:** failing tests → implement → pass → commit.

```bash
git commit -m "Add ChatboxPool for multi-chatbox monitoring"
```

---

## Task 10: Tick loop

**Files:**
- Create: `src/engine/loop.ts`
- Test: `tests/engine/loop.test.ts`

**Interfaces:**
- Produces: `class TickLoop { constructor(deps); step(): void; tick: number }` with injected clock, capture, geometry watch and pool.

Behaviour to test: exactly one capture per step; a geometry change invalidates every registered anchor; per-alerter tick divisors are honoured; a throwing alerter is isolated and marked non-functional rather than killing the loop.

- [ ] **Step 1–5:** failing tests → implement → pass → commit.

```bash
git commit -m "Add master tick loop"
```

---

## Task 11: Alt1 bindings and appconfig

**Files:**
- Create: `src/alt1-io/host.ts`, `src/alt1-io/capture.ts`, `src/alt1-io/overlay.ts`, `public/appconfig.json`, `public/icon.png`

`appconfig.json` requests `pixel,gamestate,overlay`. Window sizes stay conservative until the max-size spike runs against a real Alt1:

```json
{
  "appName": "AFK Goblin",
  "description": "AFK alerting for RuneScape 3. Modern replacement for AfkWarden.",
  "appUrl": "./index.html",
  "configUrl": "./appconfig.json",
  "iconUrl": "./icon.png",
  "defaultWidth": 280,
  "defaultHeight": 420,
  "minWidth": 200,
  "minHeight": 120,
  "maxWidth": 900,
  "maxHeight": 900,
  "permissions": "pixel,gamestate,overlay"
}
```

- [ ] **Step 1–5:** implement the real `Alt1Host` adapter over the `alt1` global, wire `captureHoldFullRs`, commit.

```bash
git commit -m "Add Alt1 host bindings and appconfig"
```

---

## Remaining alerter types (Tasks 12–25)

One task each, all following the Task 8 template: `xpcounter`, `bigxp`, `craftmenu`, `drops`, `buffs`, `actionbar`, `sheathe`, `castlewars`, `dialogtextsimple`, `fightkiln`, `targetdeath`, `summoning`, `clockbased`, `necroritual`.

Each: define vars schema → write failing tests for trigger and bar behaviour → implement `check()` against injected reader fakes → register in `src/engine/registry.ts` → commit.

`buffs` additionally consumes `scoreNeedle` from Task 3 and must have a regression test asserting a 53-opaque-pixel needle still matches at score 1.

---

## Self-review notes

- Spec §3.1 → Tasks 1, 2, 10. §3.2 → Tasks 3, and the `buffs` task. §4.4 → Task 9. §5 → Tasks 4, 5, 6. §2.1 → Tasks 8, 12–25.
- Spec §6 (UI) and §7 fixture replay are deliberately **not** in this plan; they are a second plan once the core is green.
- `threshold` spelling is consistent across Tasks 4, 5 and the `actionbar`/`xpcounter` tasks.
- `AnchorHealth` is named identically in Tasks 2, 9 and 10.
