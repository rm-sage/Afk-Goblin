/**
 * Bridge diagnostics page.
 *
 * The Lua layer only runs inside the game process and cannot be unit-tested, so
 * this is the counterpart: a page that exercises every part of the bridge and
 * shows what actually arrived. It answers the questions the test suite cannot —
 * does `plugin://` load, does the embedded browser work, do messages flow both
 * ways, does config persist, and how fast does the tick really run.
 *
 * Kept permanently rather than thrown away: it is the only way to see the Lua
 * side behaving, and it will be just as useful when detection lands.
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { listenForPlugin, requestClose, sendToPlugin } from "~/bolt-io/host";
import { SnapshotStore } from "~/bolt-io/snapshot";
import { SessionRecorder } from "~/bolt-io/recorder";
import { decodePluginMessage } from "~/bolt-io/protocol";
import type { StateMessage } from "~/bolt-io/protocol";

const store = new SnapshotStore(() => Date.now());

type LogLine = { at: number; text: string };

// Registered at module scope, NOT in an effect.
//
// Bolt queues messages sent before the page loads and delivers them once it
// has, which is earlier than any effect runs. Subscribing in useEffect loses
// everything in that queue -- which is exactly how the startup handshake went
// missing the first time this ran in-game.
// Records the whole bridge stream so a real session can be replayed in tests.
// This is what replaces Alt1's PasteInput workflow, and improves on it: a
// timeline rather than a single frame.
const recorder = new SessionRecorder(() => Date.now());

const earlyLog: LogLine[] = [];
const tickTimes: number[] = [];
let lastTickAt: number | null = null;

listenForPlugin(store);

window.addEventListener("message", (event: Event): void => {
  const data = (event as MessageEvent).data as { type?: unknown; content?: unknown } | undefined;
  if (typeof data !== "object" || data === null) return;
  if (data.type !== "pluginMessage") return;
  if (!(data.content instanceof ArrayBuffer)) return;

  const decoded = decodePluginMessage(data.content);
  if (decoded !== null) recorder.record(decoded);

  // Observation only: what bytes actually arrived, including anything the
  // schema rejected and would otherwise silently drop.
  const text = new TextDecoder().decode(data.content);
  if (text.includes('"state"')) {
    const now = Date.now();
    if (lastTickAt !== null) {
      tickTimes.push(now - lastTickAt);
      if (tickTimes.length > 20) tickTimes.shift();
    }
    lastTickAt = now;
  } else {
    earlyLog.push({ at: Date.now(), text });
    if (earlyLog.length > 12) earlyLog.shift();
  }
});

function Probe() {
  const [, force] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => force((n) => n + 1), 200);
    return () => window.clearInterval(timer);
  }, []);

  const log = earlyLog;
  const tickGaps = tickTimes;

  const state: StateMessage | null = store.state;
  const meanGap =
    tickGaps.length === 0
      ? null
      : Math.round(tickGaps.reduce((a, b) => a + b, 0) / tickGaps.length);

  return (
    <main style="font: 13px ui-monospace, monospace; padding: 12px; line-height: 1.6">
      <h1 style="font-size: 15px; margin: 0 0 10px">AFK Goblin bridge probe</h1>

      <p>
        <strong style={`color: ${store.connected ? "#2e7d32" : "#c62828"}`}>
          {store.connected ? "CONNECTED" : "NO DATA"}
        </strong>
        {"  name="}
        {store.characterName ?? "(none)"}
        {"  api="}
        {store.apiVersion === null ? "(no handshake)" : store.apiVersion.join(".")}
      </p>

      <h2 style="font-size: 13px; margin: 12px 0 4px">State</h2>
      {state === null ? (
        <p>no state message yet</p>
      ) : (
        <table>
          <tbody>
            <Row label="tick" value={String(state.tick)} />
            <Row label="clickIdleMs" value={String(state.clickIdleMs)} />
            <Row label="mouseIdleMs" value={String(state.mouseIdleMs)} />
            <Row
              label="focused"
              value={`${String(state.focused)}  (always false on Windows — upstream Bolt bug)`}
            />
            <Row label="loggedIn" value={String(state.loggedIn)} />
            <Row
              label="tick gap"
              value={meanGap === null ? "-" : `${meanGap}ms mean of ${tickGaps.length} (want ~600)`}
            />
          </tbody>
        </table>
      )}

      <h2 style="font-size: 13px; margin: 12px 0 4px">Round trip</h2>
      <p>
        <button onClick={() => sendToPlugin({ t: "save", data: `probe ${new Date().toISOString()}` })}>
          Save config
        </button>{" "}
        <button onClick={() => sendToPlugin({ t: "flash" })}>Flash window</button>{" "}
        <button onClick={() => requestClose()}>Request close</button>
      </p>

      <h2 style="font-size: 13px; margin: 12px 0 4px">Session recording</h2>
      <p>
        {recorder.length} messages captured{" "}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(JSON.stringify(recorder.toSession()));
          }}
        >
          Copy session JSON
        </button>{" "}
        <button onClick={() => recorder.clear()}>Clear</button>
      </p>
      <p style="color: #666">
        Paste into tests/fixtures/sessions/ and drive it through the engine with the replay helper.
      </p>
      <p style="color: #666">
        Save, then restart the plugin: the stored blob should come back as a config message below.
      </p>

      <h2 style="font-size: 13px; margin: 12px 0 4px">Non-state messages</h2>
      {log.length === 0 ? (
        <p>none yet</p>
      ) : (
        <ul style="padding-left: 18px; margin: 0">
          {log.map((line) => (
            <li key={`${line.at}-${line.text}`} style="word-break: break-all">
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style="padding-right: 14px; color: #666">{label}</td>
      <td>{value}</td>
    </tr>
  );
}

const root = document.getElementById("root");
if (root !== null) render(<Probe />, root);
