import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

// Bolt embeds CEF too, but a much newer one than Alt1's 108, so the target is no
// longer pinned to Chromium 108. It stays conservative rather than "esnext"
// because the host's CEF version is not something this repo controls.
//
// Output goes to `app/` so the repo root IS the plugin directory: bolt.json,
// main.lua and lua/ already live there, and main.lua loads the UI from
// `plugin://app/index.html`. Bolt installs a plugin by being pointed at its
// bolt.json, so `npm run build` is the entire dev loop -- no assembly step, and
// CI packages the same layout it runs from.
export default defineConfig({
  plugins: [preact()],
  base: "./",
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "chrome120",
    outDir: "app",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        // The app itself.
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        // Bridge diagnostics. Ships alongside because the Lua layer has no unit
        // tests, so seeing it behave in-game is the only verification there is.
        probe: fileURLToPath(new URL("./probe.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
