import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BOLT RUNS LUAJIT, WHICH IS LUA 5.1. The test harness runs wasmoon, which is
 * Lua 5.4. Everything in `lua/` therefore has to be written in the smaller
 * dialect, and nothing else in this repo can notice when it is not.
 *
 * This is not a hypothetical. `spriteid` was written with `//`, `~` and `&` —
 * integer division and bitwise operators, all Lua 5.3 additions. wasmoon
 * compiled them happily and 397 tests passed. In game they are a SYNTAX ERROR,
 * so `require("lua.detect.buffs")` failed, main.lua raised at load, and Bolt
 * stopped the plugin the instant it was enabled. The symptom was the enable
 * toggle flipping itself back off, with nothing in any log this side of Bolt.
 *
 * Confirmed from the shipped binary rather than assumed: bolt.exe exports
 * lua_getfenv, lua_setfenv, lua_objlen, lua_lessthan and lua_cpcall — all
 * removed after 5.1 — exports none of lua_rotate, lua_absindex, lua_geti,
 * lua_arith or lua_isinteger, and carries the banners "Lua 5.1" and
 * "LuaJIT 2.1.1716656478".
 *
 * CI byte-compiles every file with luajit, which is the authoritative check.
 * This exists because that runs on a push and this runs in a second, and the
 * gap between those two is where an evening goes.
 */

const root = new URL("../../", import.meta.url);

/** Every Lua file the plugin actually loads. Vendored modules are not ours. */
function pluginLuaFiles(): string[] {
  const out: string[] = ["main.lua"];
  const walk = (rel: string): void => {
    const dir = fileURLToPath(new URL(rel, root));
    for (const entry of readdirSync(dir)) {
      const child = `${rel}${entry}`;
      if (statSync(fileURLToPath(new URL(child, root))).isDirectory()) walk(`${child}/`);
      else if (entry.endsWith(".lua")) out.push(child);
    }
  };
  walk("lua/");
  return out;
}

/**
 * Blank out comments and string literals, keeping length and line structure.
 *
 * Needed because the operators below appear constantly inside both — `//` in
 * every URL, `~` and `&` and `|` as glyph values in the vendored font tables —
 * and a scanner that cannot tell code from data reports nothing but noise.
 */
export function stripLuaCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let n = from; n < to && n < out.length; n++) {
      if (out[n] !== "\n") out[n] = " ";
    }
  };

  /** Length of a long-bracket opener at `at`, or 0. */
  const longOpen = (at: number): number => {
    if (src[at] !== "[") return 0;
    let n = at + 1;
    while (src[n] === "=") n++;
    return src[n] === "[" ? n - at + 1 : 0;
  };

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === "--") {
      const open = longOpen(i + 2);
      if (open > 0) {
        const close = `]${"=".repeat(open - 2)}]`;
        const end = src.indexOf(close, i + 2 + open);
        const stop = end === -1 ? src.length : end + close.length;
        blank(i, stop);
        i = stop;
      } else {
        const nl = src.indexOf("\n", i);
        const stop = nl === -1 ? src.length : nl;
        blank(i, stop);
        i = stop;
      }
      continue;
    }

    const open = longOpen(i);
    if (open > 0) {
      const close = `]${"=".repeat(open - 2)}]`;
      const end = src.indexOf(close, i + open);
      const stop = end === -1 ? src.length : end + close.length;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      let n = i + 1;
      while (n < src.length && src[n] !== quote) {
        if (src[n] === "\\") n++;
        if (src[n] === "\n") break;
        n++;
      }
      blank(i, n + 1);
      i = n + 1;
      continue;
    }

    i++;
  }

  return out.join("");
}

/** Constructs LuaJIT (5.1) rejects outright. */
const FORBIDDEN: Array<{ name: string; re: RegExp; instead: string }> = [
  { name: "integer division (//)", re: /\/\//, instead: "math.floor(a / b)" },
  { name: "bitwise and (&)", re: /(?<![&])&(?![&])/, instead: "arithmetic, or LuaJIT's bit library" },
  { name: "bitwise or (|)", re: /(?<![|])\|(?![|])/, instead: "arithmetic, or LuaJIT's bit library" },
  { name: "bitwise xor / not (~)", re: /~(?!=)/, instead: "arithmetic, or LuaJIT's bit library" },
  { name: "shift (<< or >>)", re: /<<|>>/, instead: "multiplication or division by a power of two" },
  { name: "attribute (<const> / <close>)", re: /<\s*(const|close)\s*>/, instead: "a plain local" },
  { name: "integer literal suffix", re: /\b\d+[lL][lL]\b/, instead: "a plain number" },
];

describe("plugin Lua stays inside the dialect Bolt runs", () => {
  it("finds the files it is supposed to be checking", () => {
    const files = pluginLuaFiles();
    expect(files).toContain("main.lua");
    expect(files).toContain("lua/detect/buffs.lua");
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(pluginLuaFiles())("%s uses no syntax newer than Lua 5.1", (file) => {
    const code = stripLuaCommentsAndStrings(
      readFileSync(fileURLToPath(new URL(file, root)), "utf8"),
    );

    const offences: string[] = [];
    code.split("\n").forEach((line, n) => {
      for (const rule of FORBIDDEN) {
        if (rule.re.test(line)) {
          offences.push(`${file}:${n + 1}: ${rule.name} — use ${rule.instead}\n    ${line.trim()}`);
        }
      }
    });

    expect(offences, `\n${offences.join("\n")}\n`).toEqual([]);
  });

  it("does not mistake operators inside comments and strings for code", () => {
    const stripped = stripLuaCommentsAndStrings(
      [
        `-- a comment with // and ~ and &`,
        `local url = "plugin://app/index.html"`,
        `local glyph = '~'`,
        `--[[ a long comment with | and << ]]`,
        `local ok = a ~= b`,
      ].join("\n"),
    );

    for (const rule of FORBIDDEN) expect(rule.re.test(stripped)).toBe(false);
    // `~=` must survive, or the scanner would flag every inequality in the repo.
    expect(stripped).toContain("~=");
  });
});
