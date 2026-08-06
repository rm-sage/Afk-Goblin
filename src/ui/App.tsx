import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ActiveAlerter, TickLoop } from "~/engine/loop";
import type { AlerterBase, Preset, Settings } from "~/store/schema";
import { importAfkWardenJson, type ImportIssue } from "~/import/afkwarden";
import { toAfkWardenPreset } from "~/import/export";
import { AlertEditor } from "~/ui/AlertEditor";
import { SettingsDialog } from "~/ui/SettingsDialog";
import { useDragList, type DragState } from "~/ui/useDragList";
import type { DropTarget } from "~/engine/reorder";

export type PresetAction =
  | { kind: "new"; name: string }
  | { kind: "rename"; name: string }
  | { kind: "duplicate"; name: string }
  | { kind: "delete" };

export type AppProps = {
  loop: TickLoop;
  /** Whether the Lua plugin is currently pushing state. */
  connected: boolean;
  /** Logged-in character's display name, or null in the lobby. */
  characterName: string | null;
  presets: Preset[];
  activePreset: string | null;
  settings: Settings;
  onSelectPreset(name: string): void;
  onImport(presets: Preset[]): void;
  onSettings(next: Settings): void;
  onTogglePause(index: number): void;
  /** index null means "append a new alert". */
  onSaveAlert(index: number | null, alert: AlerterBase): void;
  onDeleteAlert(index: number): void;
  onReorder(from: number, target: DropTarget): void;
  soundNames: string[];
  missingSounds: string[];
  onAddSounds(files: FileList): void;
  onRemoveSound(name: string): void;
  onPresetAction(action: PresetAction): void;
};

/** Re-render on a timer rather than pushing from the loop: simpler, and 5fps is plenty. */
function useRepaint(ms = 200): void {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * Whether the plugin is talking to us.
 *
 * Replaces the old chatbox-health pill. Under Alt1 that pill answered "can I
 * still find the chatbox on screen?", a question Bolt makes meaningless: it
 * reads the game's draw calls, so there is nothing to locate. The one thing
 * that can now go wrong is the plugin going quiet, and that is what this shows.
 */
function HealthPill({ connected, character }: { connected: boolean; character: string | null }) {
  const label = connected ? (character ?? "connected") : "no data";
  const title = connected
    ? character !== null
      ? `Connected to the plugin, logged in as ${character}.`
      : "Connected to the plugin. Not logged in."
    : "Not receiving data from the plugin. Is it running?";

  return (
    <span class={`health health--${connected ? "ok" : "lost"}`} title={title}>
      <span class="health__dot" />
      {label}
    </span>
  );
}

function Row({
  a,
  index,
  drag,
  shift,
  onTogglePause,
  onEdit,
  onGrip,
}: {
  a: ActiveAlerter;
  index: number;
  drag: DragState | null;
  shift: number;
  onTogglePause(): void;
  onEdit(): void;
  onGrip(e: PointerEvent): void;
}) {
  const dragging = drag?.from === index;
  const isDropTarget = drag?.target?.kind === "onto" && drag.target.index === index;

  const cls = [
    "row",
    a.state.triggered ? "row--fired" : "",
    a.config.paused ? "row--paused" : "",
    a.error !== null ? "row--broken" : "",
    dragging ? "row--dragging" : "",
    isDropTarget ? "row--groupinto" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const style = dragging
    ? { transform: `translateY(${drag.offsetY}px) scale(1.02)` }
    : shift !== 0
      ? { transform: `translateY(${shift}px)` }
      : undefined;

  return (
    <div class={cls} data-index={index} style={style} title={a.error ?? a.config.tooltip ?? a.config.name}>
      <div class="row__bar" style={{ width: `${Math.round(a.state.bar * 100)}%` }} />
      <span
        class="row__grip"
        title="Drag to reorder — drop onto another alert to group them"
        onPointerDown={onGrip}
      >
        ⠿
      </span>
      <span class="row__name">{a.config.name || "(unnamed)"}</span>
      <span class="row__side">
        {a.error !== null ? <span class="badge badge--err">!</span> : null}
        {a.error === null && !a.state.functional ? (
          <span class="badge" title="This alert cannot see what it needs right now.">
            no data
          </span>
        ) : null}
        <button class="iconbtn" onClick={onEdit} title="Edit" aria-label="Edit">
          ✎
        </button>
        <button
          class="iconbtn"
          onClick={onTogglePause}
          title={a.config.paused ? "Resume" : "Pause"}
          aria-label={a.config.paused ? "Resume" : "Pause"}
        >
          {a.config.paused ? "▶" : "❚❚"}
        </button>
      </span>
    </div>
  );
}

function ImportDialog({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose(): void;
  onImport(presets: Preset[]): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [issues, setIssues] = useState<ImportIssue[]>([]);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const run = useCallback(() => {
    const result = importAfkWardenJson(text);
    setIssues(result.issues);
    // Unlike AfkWarden -- which logs "invalid import" to a console nobody has open
    // and otherwise does nothing -- failures stay on screen.
    if (result.ok) {
      onImport(result.presets);
      if (result.issues.length === 0) {
        setText("");
        onClose();
      }
    }
  }, [text, onImport, onClose]);

  return (
    <dialog ref={ref} onCancel={onClose}>
      <h2>Import from AfkWarden</h2>
      <p class="fld__help">
        In AfkWarden, open the save icon, choose a preset and press Export, then paste it here. The
        whole <code>afkscape_presets</code> blob works too.
      </p>
      <textarea
        value={text}
        placeholder='{"name":"Mining","baseName":"mining","alerters":[...]}'
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      {issues.length > 0 ? (
        <ul class="issues">
          {issues.map((i, n) => (
            <li key={n}>
              <strong>{i.path}</strong> — {i.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div class="dlg__actions">
        <button class="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button class="btn" onClick={run} disabled={text.trim().length === 0}>
          Import
        </button>
      </div>
    </dialog>
  );
}

function ExportDialog({
  preset,
  onClose,
}: {
  preset: Preset | null;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (preset !== null && !d.open) d.showModal();
    if (preset === null && d.open) d.close();
  }, [preset]);

  const json = preset === null ? "" : JSON.stringify(toAfkWardenPreset(preset));

  return (
    <dialog ref={ref} onCancel={onClose}>
      <h2>Export “{preset?.name ?? ""}”</h2>
      <p class="fld__help">
        AfkWarden-compatible, so this pastes straight back into the original if you ever want it
        there.
      </p>
      <textarea readOnly value={json} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
      <div class="dlg__actions">
        <button
          class="btn btn--ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(json);
          }}
        >
          Copy
        </button>
        <button class="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  );
}

export function App(props: AppProps) {
  useRepaint();
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState<Preset | null>(null);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);

  const { loop, presets, activePreset, settings, connected, characterName } = props;
  const preset = presets.find((p) => p.name === activePreset) ?? null;

  const { drag, listRef, startDrag, shiftFor } = useDragList(props.onReorder);
  // Rows are uniform, so one step covers the gap-opening animation. Drop
  // decisions use real measured rects, so an imprecise value here is cosmetic.
  const rowHeight = 37;

  // Preserve configured order while collecting rows under their group heading.
  const sections = useMemo(() => {
    const out: Array<{ group: string | null; items: Array<{ a: ActiveAlerter; i: number }> }> = [];
    loop.alerters.forEach((a, i) => {
      const g = a.config.group;
      const last = out[out.length - 1];
      if (last !== undefined && last.group === g) last.items.push({ a, i });
      else out.push({ group: g, items: [{ a, i }] });
    });
    return out;
  }, [loop.alerters, loop.alerters.length]);

  const groups = useMemo(
    () => [...new Set(loop.alerters.map((a) => a.config.group).filter((g): g is string => g !== null))],
    [loop.alerters],
  );

  const anyAlerters = loop.alerters.length > 0;
  const editingAlert =
    editing === null || editing.index === null
      ? null
      : (loop.alerters[editing.index]?.config ?? null);

  const promptPreset = (kind: "new" | "rename" | "duplicate"): void => {
    const suggestion =
      kind === "new" ? "New preset" : kind === "duplicate" ? `${preset?.name ?? ""} copy` : preset?.name ?? "";
    const name = globalThis.prompt(
      kind === "rename" ? "Rename preset to" : "Preset name",
      suggestion,
    );
    if (name === null || name.trim().length === 0) return;
    props.onPresetAction({ kind, name: name.trim() });
  };

  return (
    <>
      <header class="hdr">
        <select
          class="hdr__preset"
          value={activePreset ?? ""}
          onChange={(e) => props.onSelectPreset((e.target as HTMLSelectElement).value)}
          disabled={presets.length === 0}
        >
          {presets.length === 0 ? <option value="">No presets</option> : null}
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <HealthPill connected={connected} character={characterName} />
      </header>

      <div class="subhdr">
        <button class="toolbtn" title="New preset" aria-label="New preset" onClick={() => promptPreset("new")}>
          🗋
        </button>
        <button
          class="toolbtn"
          title="Rename preset"
          aria-label="Rename preset"
          disabled={preset === null}
          onClick={() => promptPreset("rename")}
        >
          ✏
        </button>
        <button
          class="toolbtn"
          title="Duplicate preset"
          aria-label="Duplicate preset"
          disabled={preset === null}
          onClick={() => promptPreset("duplicate")}
        >
          ⧉
        </button>
        <span class="toolbtn__sep" />
        <button
          class="toolbtn"
          title="Export preset"
          aria-label="Export preset"
          disabled={preset === null}
          onClick={() => setExporting(preset)}
        >
          ⬆
        </button>
        <button
          class="toolbtn"
          title="Import from AfkWarden"
          aria-label="Import from AfkWarden"
          onClick={() => setImportOpen(true)}
        >
          ⬇
        </button>
        <button
          class="toolbtn toolbtn--danger"
          title="Delete preset"
          aria-label="Delete preset"
          disabled={preset === null}
          onClick={() => {
            if (preset === null) return;
            if (globalThis.confirm(`Delete preset “${preset.name}”?`)) {
              props.onPresetAction({ kind: "delete" });
            }
          }}
        >
          🗑
        </button>
        <span class="ftr__spacer" />
        <button
          class="toolbtn toolbtn--accent"
          title="Add alert"
          aria-label="Add alert"
          disabled={preset === null}
          onClick={() => setEditing({ index: null })}
        >
          ＋
        </button>
      </div>

      {loop.heldReason !== null ? (
        <div class="held">
          <span class="held__dot" />
          {loop.heldReason} — alerts are on hold.
        </div>
      ) : null}

      <main class={`list${drag !== null ? " list--dragging" : ""}`} ref={listRef}>
        {anyAlerters ? (
          sections.map((s, n) => (
            <>
              {s.group !== null ? (
                <div class="group" key={`g${n}`}>
                  {s.group}
                </div>
              ) : null}
              {s.items.map(({ a, i }) => (
                <Row
                  key={i}
                  a={a}
                  index={i}
                  drag={drag}
                  shift={shiftFor(i, rowHeight)}
                  onTogglePause={() => props.onTogglePause(i)}
                  onEdit={() => setEditing({ index: i })}
                  onGrip={(e) => startDrag(i, e)}
                />
              ))}
            </>
          ))
        ) : (
          <div class="empty">
            <h2>{preset === null ? "No presets yet" : "No alerts in this preset"}</h2>
            <p>
              Bring your AfkWarden setup across — presets, alerts and all — or start a new one from
              scratch.
            </p>
            <button class="btn" onClick={() => setImportOpen(true)}>
              Import from AfkWarden
            </button>
            <button class="btn btn--ghost" onClick={() => promptPreset("new")}>
              New empty preset
            </button>
          </div>
        )}
      </main>

      <footer class="ftr">
        <button class="iconbtn" onClick={() => setSettingsOpen(true)} title="Settings">
          ⚙
        </button>
        <button
          class="iconbtn"
          onClick={() => props.onSettings({ ...settings, muted: !settings.muted })}
          title={settings.muted ? "Unmute" : "Mute"}
        >
          {settings.muted ? "🔇" : "🔊"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.volume}
          disabled={settings.muted}
          onInput={(e) =>
            props.onSettings({ ...settings, volume: Number((e.target as HTMLInputElement).value) })
          }
          title="Volume"
        />
        <span class="ftr__spacer" />
        <span title="Alerts currently firing">
          {loop.triggered().length}/{loop.alerters.length}
        </span>
      </footer>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={props.onImport}
      />
      <ExportDialog preset={exporting} onClose={() => setExporting(null)} />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        soundNames={props.soundNames}
        missingSounds={props.missingSounds}
        onChange={props.onSettings}
        onAddSounds={props.onAddSounds}
        onRemoveSound={props.onRemoveSound}
        onClose={() => setSettingsOpen(false)}
      />
      <AlertEditor
        open={editing !== null}
        alert={editingAlert}
        groups={groups}
        soundNames={props.soundNames}
        onSave={(next) => {
          props.onSaveAlert(editing?.index ?? null, next);
          setEditing(null);
        }}
        onDelete={() => {
          if (editing?.index != null) props.onDeleteAlert(editing.index);
          setEditing(null);
        }}
        onClose={() => setEditing(null)}
      />
    </>
  );
}
