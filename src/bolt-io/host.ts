import { decodePluginMessage } from "~/bolt-io/protocol";
import type { SnapshotStore } from "~/bolt-io/snapshot";

/**
 * Transport between this page and the Lua plugin.
 *
 * Inbound arrives as `window.postMessage`; outbound goes by POST to
 * `https://bolt-api/`, which Bolt intercepts inside the browser process. This
 * module is deliberately the only place that knows either mechanism, and holds
 * no logic of its own — decoding lives in protocol.ts, state in snapshot.ts.
 */
const BOLT_API = "https://bolt-api";

/** Messages this page can ask the plugin to act on. */
export type HostMessage =
  | { t: "highlight"; models: string[] }
  | { t: "flash" }
  | { t: "save"; data: string };

export function sendToPlugin(message: HostMessage): void {
  // Fire and forget: the plugin acts on it, and there is nothing to await.
  void fetch(`${BOLT_API}/send-message`, {
    method: "POST",
    body: JSON.stringify(message),
  }).catch(() => {
    // Outside Bolt (a plain browser during development) this host does not
    // exist. That is not an error worth surfacing.
  });
}

/**
 * Ask Bolt to close the plugin window.
 *
 * CEF disables `window.close()`, so self-closing has its own endpoint. It fires
 * `oncloserequest` in Lua rather than closing anything directly.
 */
export function requestClose(): void {
  void fetch(`${BOLT_API}/close-request`).catch(() => {});
}

/**
 * Route inbound plugin messages into the store. Returns an unsubscribe function.
 *
 * `target` is injectable so this is testable without a DOM; in the app it is
 * `window`.
 */
export function listenForPlugin(
  store: SnapshotStore,
  target: EventTarget = window,
): () => void {
  const onMessage = (event: Event): void => {
    const data = (event as MessageEvent).data as unknown;
    if (typeof data !== "object" || data === null) return;

    const { type, content } = data as { type?: unknown; content?: unknown };
    // Screen captures share this channel; reading one as JSON would mean
    // decoding raw RGB pixels on every captured frame.
    if (type !== "pluginMessage") return;
    if (!(content instanceof ArrayBuffer)) return;

    const message = decodePluginMessage(content);
    if (message !== null) store.accept(message);
  };

  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}
