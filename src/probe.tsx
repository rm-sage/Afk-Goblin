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
import type { StateMessage } from "~/bolt-io/protocol";

const store = new SnapshotStore(() => Date.now());

type LogLine = { at: number; text: string };

function Probe() {
  const [, force] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [tickGaps, setTickGaps] = useState<number[]>([]);

  useEffect(() => {
    const stop = listenForPlugin(store);

    // A second listener purely for observation: what bytes actually arrived,
    // including anything the schema rejected.
    let lastTickAt: number | null = null;
    const raw = (event: Event): void => {
      const data = (event as MessageEvent).data as
        | { type?: unknown; content?: unknown }
        | undefined;
      if (typeof data !== "object" || data === null) return;
      if (data.type !== "pluginMessage") return;
      if (!(data.content instanceof ArrayBuffer)) return;

      const text = new TextDecoder().decode(data.content);
      if (text.includes('"state"')) {
        const now = Date.now();
        if (lastTickAt !== null) {
          setTickGaps((gaps) => [...gaps.slice(-19), now - lastTickAt!]);
        }
        lastTickAt = now;
      } else {
        setLog((lines) => [...lines.slice(-11), { at: Date.now(), text }]);
      }
    };
    window.addEventListener("message", raw);

    const timer = window.setInterval(() => force((n) => n + 1), 200);
    return () => {
      stop();
      window.removeEventListener("message", raw);
      window.clearInterval(timer);
    };
  }, []);

  const state: StateMessage | null = store.state;
  const meanGap =
    tickGaps.length === 0
      ? null
      : Math.round(tickGaps.reduce((a, b) => a + b, 0) / tickGaps.length);

  return (
    <main style="font: 13px ui-monospace, monospace; padding: 12px; line-height: 1.6">
      <h1 style="font-size: 15px; margin: 0 0 10px">AfkUAV bridge probe</h1>

      <p>
        <strong style={`color: ${store.connected ? "#2e7d32" : "#c62828"}`}>
          {store.connected ? "CONNECTED" : "NO DATA"}
        </strong>
        {"  character="}
        {store.character ?? "(none)"}
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
            <Row label="focused" value={String(state.focused)} />
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
