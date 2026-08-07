import { render } from "preact";
import { listenForPlugin, sendToPlugin } from "~/bolt-io/host";
import { SnapshotStore } from "~/bolt-io/snapshot";
import { GameStateView } from "~/bolt-io/game-state";
import { AlarmScheduler } from "~/alerting/alarm";
import { SoundPlayer } from "~/alerting/player";
import { SoundLibrary, labelFromFilename, resolveSound } from "~/alerting/sound-library";
import { shouldSuppress } from "~/alerting/taskbar";
import { TICK_MS, TickLoop } from "~/engine/loop";
import { Store } from "~/store/storage";
import { PresetSchema, type AlerterBase, type Preset, type Settings } from "~/store/schema";
import type { ChatLine } from "~/engine/types";
import { applyDrop } from "~/engine/reorder";
import { speak } from "~/alerting/speech";
import { App, type PresetAction } from "~/ui/App";
import "~/ui/styles.css";

// Subscribed at module scope, before render. Bolt queues messages sent before
// the page loads and delivers them once it has, which is earlier than any effect
// runs -- subscribing later drops the whole queue, handshake included.
const snapshot = new SnapshotStore(() => Date.now());
listenForPlugin(snapshot);

const store = new Store();
let presets: Preset[] = store.loadPresets();
let settings: Settings = store.loadSettings();
let activeName: string | null = store.loadActivePresetName() ?? presets[0]?.name ?? null;

const view = new GameStateView(snapshot);

const loop = new TickLoop({
  now: () => Date.now(),
  idleMs: () => snapshot.state?.clickIdleMs ?? 0,
  mouseIdleMs: () => snapshot.state?.mouseIdleMs ?? 0,
  connected: () => snapshot.connected,
  loggedIn: () => snapshot.state?.loggedIn ?? false,
  suppressWhenLoggedOut: () => settings.suppressWhenLoggedOut,
  state: () => view.state,
  chatAvailable: () => snapshot.state?.chatAvailable ?? false,
  chatLines: () => {
    const lines = snapshot.drainChat();
    if (lines.length > 0) {
      recentChat = [...recentChat, ...lines].slice(-RECENT_CHAT_MAX);
    }
    return lines;
  },
});

function activePreset(): Preset | null {
  return presets.find((p) => p.name === activeName) ?? null;
}

function applyPreset(): void {
  loop.setAlerters(activePreset()?.alerters ?? []);
  paint();
}

const alarms = new AlarmScheduler();
const sounds = new SoundLibrary();
const player = new SoundPlayer(sounds);

void sounds.load().then(paint);

/** Sound labels alerts refer to but for which no audio has been supplied. */
function missingSounds(): string[] {
  const wanted = new Set<string>();
  for (const a of loop.alerters) {
    if (a.config.alarm !== null) wanted.add(a.config.alarm.sound);
  }
  if (settings.globalAlarm !== null) wanted.add(settings.globalAlarm.sound);

  return [...wanted]
    .map((s) => resolveSound(s, sounds.names))
    .filter((r) => r.kind === "missing")
    .map((r) => r.name);
}
globalThis.addEventListener("beforeunload", () => {
  player.stopAll();
});

/** Alerts that were speaking last tick, so each transition speaks exactly once. */
const spoken = new Set<string>();

function dispatchAlerts(): void {
  // NOTE: `focused` is always false on Windows — Bolt reports it with GetFocus(),
  // which only sees a focus window on the calling thread's message queue, and Lua
  // runs on the render thread. This fails safe: activeSuppress defaults off, and
  // a stuck-false focus means alerts are never suppressed rather than silenced.
  const focused = snapshot.state?.focused ?? false;
  // Suppression keys off how recently you clicked, not focus: alt-tabbing to read
  // something is not the same as having stopped playing.
  const quiet = shouldSuppress(settings.activeSuppress, snapshot.state?.clickIdleMs ?? 0, focused);
  const suppressed = settings.muted || quiet;
  const tooltips: string[] = [];

  const sources = loop.alerters.map((a, i) => ({
    key: `${i}:${a.config.name}`,
    triggered: a.state.triggered,
    alarm: a.config.alarm,
    globalalarm: a.config.globalalarm,
  }));

  // `quiet` is passed as the suppression flag the scheduler already understands.
  player.apply(alarms.update(sources, settings, quiet));

  // TODO(P1.5): the taskbar progress overlay and hover tooltip were Alt1 APIs
  // with no Bolt equivalent. Bolt can draw surfaces into the game view instead,
  // which would be a better home for both, but that is a design decision rather
  // than a port — see the migration spec. Deliberately dropped for now, not
  // silently forgotten.

  loop.alerters.forEach((a, i) => {
    const key = `${i}:${a.config.name}`;
    if (!a.state.triggered) {
      spoken.delete(key);
      return;
    }
    if (a.config.tooltip !== null && a.config.tooltip.length > 0) tooltips.push(a.config.tooltip);
    if (spoken.has(key)) return;
    spoken.add(key);
    if (a.config.voice !== null && !suppressed) speak(a.config.voice, settings.volume);
  });

  // Tooltip surface dropped with Alt1 — see the TODO above. Tooltips are still
  // collected so nothing depends on them disappearing.
  void tooltips;
}

/**
 * Chat lines kept purely so the picker can offer real ones.
 *
 * The loop DRAINS chat, so a line is gone the moment it has been evaluated.
 * The picker needs a short history instead of a single tick's worth, hence a
 * separate rolling buffer rather than reading the store again.
 */
const RECENT_CHAT_MAX = 40;
let recentChat: ChatLine[] = [];

function tick(): void {
  // Fold XP drops into the running totals before stepping, so alerters see this
  // tick's gains rather than last tick's.
  view.drainInto();
  loop.step();
  dispatchAlerts();
}

const root = document.getElementById("root");

function paint(): void {
  if (root === null) return;
  render(
    <App
      loop={loop}
      connected={snapshot.connected}
      characterName={snapshot.characterName}
      presets={presets}
      activePreset={activeName}
      settings={settings}
      onSelectPreset={(name) => {
        activeName = name;
        store.saveActivePresetName(name);
        applyPreset();
      }}
      onImport={(imported) => {
        // Imported names win over existing ones so re-importing updates in place.
        const byName = new Map(presets.map((p) => [p.name, p]));
        for (const p of imported) byName.set(p.name, p);
        presets = [...byName.values()];
        store.savePresets(presets);
        if (activeName === null || !byName.has(activeName)) {
          activeName = imported[0]?.name ?? null;
          store.saveActivePresetName(activeName);
        }
        applyPreset();
      }}
      onSettings={(next) => {
        settings = next;
        store.saveSettings(next);
        paint();
      }}
      onTogglePause={(index) => {
        mutateAlerts((alerts) => {
          const a = alerts[index];
          if (a !== undefined) a.paused = !a.paused;
        });
      }}
      onSaveAlert={(index, next) => {
        mutateAlerts((alerts) => {
          if (index === null) alerts.push(next);
          else alerts[index] = next;
        });
      }}
      onDeleteAlert={(index) => {
        mutateAlerts((alerts) => {
          alerts.splice(index, 1);
        });
      }}
      onReorder={(from, target) => {
        mutateAlerts((alerts) => {
          alerts.splice(0, alerts.length, ...applyDrop(alerts, from, target));
        });
      }}
      liveBuffs={snapshot.state?.buffs ?? []}
      liveDebuffs={snapshot.state?.debuffs ?? []}
      recentChat={recentChat}
      soundNames={[...sounds.names].sort()}
      missingSounds={missingSounds()}
      onAddSounds={(files) => {
        // Named from the filename so an imported `upload:<id>:<label>` ref
        // reconnects to the same file the user originally uploaded.
        void Promise.all(
          [...files].map((f) => sounds.add(labelFromFilename(f.name), f)),
        ).then(paint);
      }}
      onRemoveSound={(name) => {
        void sounds.remove(name).then(paint);
      }}
      onPresetAction={handlePresetAction}
    />,
    root,
  );
}

/** Edit the active preset's alerts in place, then persist and rebuild the runtime. */
function mutateAlerts(fn: (alerts: AlerterBase[]) => void): void {
  const preset = activePreset();
  if (preset === null) return;
  fn(preset.alerters);
  // Groups are derived from the alerts, so recompute rather than letting the two
  // drift apart.
  preset.groups = [...new Set(preset.alerters.map((a) => a.group).filter((g): g is string => g !== null))];
  store.savePresets(presets);
  applyPreset();
}

function uniqueName(base: string): string {
  if (!presets.some((p) => p.name === base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!presets.some((p) => p.name === candidate)) return candidate;
  }
}

function handlePresetAction(action: PresetAction): void {
  const current = activePreset();

  if (action.kind === "new") {
    const preset = PresetSchema.parse({ name: uniqueName(action.name), alerters: [] });
    presets = [...presets, preset];
    activeName = preset.name;
  } else if (action.kind === "duplicate") {
    if (current === null) return;
    const copy = PresetSchema.parse({
      ...structuredClone(current),
      name: uniqueName(action.name),
    });
    presets = [...presets, copy];
    activeName = copy.name;
  } else if (action.kind === "rename") {
    if (current === null) return;
    const name = uniqueName(action.name);
    // Renaming in place keeps position in the list, which is where the user
    // expects to find it afterwards.
    current.name = name;
    activeName = name;
  } else {
    if (current === null) return;
    presets = presets.filter((p) => p !== current);
    activeName = presets[0]?.name ?? null;
  }

  store.savePresets(presets);
  store.saveActivePresetName(activeName);
  applyPreset();
}

applyPreset();
setInterval(tick, TICK_MS);
