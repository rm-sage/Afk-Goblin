import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ActiveAlerter, TickLoop } from "~/engine/loop";
import type { AlerterBase, Preset, Settings } from "~/store/schema";
import { importAfkWardenJson, type ImportIssue } from "~/import/afkwarden";
import { toAfkWardenPreset } from "~/import/export";
import { AlertEditor } from "~/ui/AlertEditor";
import { SettingsDialog } from "~/ui/SettingsDialog";
import { useDragList, type DragState } from "~/ui/useDragList";
import type { DropTarget } from "~/engine/reorder";
import type { BuffSlot, ChatLine, Stats } from "~/engine/types";
import type { Diagnostics, ProbeMessage } from "~/bolt-io/protocol";
import { probeReport, selectAndCopy } from "~/ui/probe-report";
import { awaitsDetection } from "~/engine/registry";

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
  /** Chat reader health, surfaced because both failure modes are user-fixable. */
  chat: { available: boolean; scrolledUp: boolean; boxes: number };
  liveBuffs: readonly BuffSlot[];
  liveDebuffs: readonly BuffSlot[];
  /** What detection saw last tick, or null before the first snapshot. */
  diag: Diagnostics | null;
  /** The four resource levels, or null when the action bar could not be read. */
  stats: Stats | null;
  /** The most recent draw-stream sample, or null if none has been asked for. */
  probe: ProbeMessage | null;
  onProbe(): void;
  recentChat: readonly ChatLine[];
  onAddSounds(files: FileList): void;
  onRemoveSound(name: string): void;
  onPresetAction(action: PresetAction): void;
  /** Force a write of presets and settings. Saving is automatic; this confirms it. */
  onSave(): void;
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
function HealthPill({
  connected,
  character,
  chat,
  expanded,
  onToggle,
}: {
  connected: boolean;
  character: string | null;
  chat: { available: boolean; scrolledUp: boolean; boxes: number };
  expanded: boolean;
  onToggle(): void;
}) {
  const label = connected ? (character ?? "connected") : "no data";

  // Both chat failure modes are things the user can fix, so name the fix rather
  // than reporting a bare "not working".
  const chatNote = !connected
    ? ""
    : chat.scrolledUp
      ? " Chat is scrolled up, so new messages cannot be read."
      : !chat.available
        ? " Chat is not readable — enable message timestamps in game."
        : ` Reading ${chat.boxes} chat box${chat.boxes === 1 ? "" : "es"}.`;

  const title =
    (connected
      ? character !== null
        ? `Connected to the plugin, logged in as ${character}.`
        : "Connected to the plugin. Not logged in."
      : "Not receiving data from the plugin. Is it running?") +
    chatNote +
    " Click for detection details.";

  const degraded = connected && !chat.available;

  return (
    <button
      type="button"
      class={`health health--${!connected ? "lost" : degraded ? "searching" : "ok"}`}
      title={title}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span class="health__dot" />
      {label}
      <span class="health__caret">{expanded ? "▴" : "▾"}</span>
    </button>
  );
}

/**
 * What detection can actually see, in words rather than in booleans.
 *
 * This exists because "chat is not readable" and "no buffs are active" were
 * being reported for causes that need completely different fixes, and the
 * message named only the most common one. Someone would then spend an evening
 * toggling a game setting that was never the problem. Each row here says what
 * was counted and what that count means, so the next thing to try is obvious —
 * and so a genuine plugin bug reads as a plugin bug rather than as user error.
 */
function DetectionPanel({
  connected,
  diag,
  buffs,
  debuffs,
  stats,
  probe,
  onProbe,
}: {
  connected: boolean;
  diag: Diagnostics | null;
  buffs: readonly BuffSlot[];
  debuffs: readonly BuffSlot[];
  stats: Stats | null;
  probe: ProbeMessage | null;
  onProbe(): void;
}) {
  // Three states, not two. A button that says "Copied." after a copy that did
  // not happen is worse than one that does nothing: it sends someone off to
  // paste whatever was on the clipboard beforehand and to trust it.
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const dump = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (copied === null) return;
    const id = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  if (!connected || diag === null) {
    return (
      <div class="diag">
        <p class="diag__verdict diag__verdict--bad">
          No data from the plugin. Is AFK Goblin running in Bolt, and is the game open?
        </p>
      </div>
    );
  }

  // Before anything else: was detection fed at all? Every count below is
  // ambiguous without this, and a scan that never ran looked exactly like an
  // empty screen for two sessions running.
  if (diag.render2dEvents === 0) {
    return (
      <div class="diag">
        <p class="diag__verdict diag__verdict--bad">
          The plugin is connected but is being shown nothing to read — no draw calls reached it last
          tick. Nothing can be detected in this state. If the game is running and visible, this is a
          plugin bug and worth reporting.
        </p>
        <dl class="diag__grid">
          <dt>Draw calls last tick</dt>
          <dd>0</dd>
        </dl>
      </div>
    );
  }

  const chatVerdict =
    diag.chatConfirmed > 0 && diag.chatScrolledBoxes >= diag.chatConfirmed
      ? {
          ok: false,
          text: `Every chat box on screen is scrolled up, so new messages are off-screen. Scroll one back to the bottom.`,
        }
      : diag.chatConfirmed > 0
        ? {
            ok: true,
            text: `Reading ${diag.chatConfirmed} chat box${diag.chatConfirmed === 1 ? "" : "es"}.`,
          }
        : diag.chatBubbles > 0
          ? {
              ok: false,
              text:
                `Found ${diag.chatBubbles} chat box${diag.chatBubbles === 1 ? "" : "es"} but could not read ` +
                `${diag.chatBubbles === 1 ? "it" : "them"}. This is what a missing timestamp looks like — turn on ` +
                `message timestamps in the in-game chat settings.`,
            }
          : diag.chatBubblesEver > 0
            ? {
                ok: false,
                text:
                  "Chat was found earlier but not on the frame just checked, so it is being seen only some of the " +
                  "time. Messages will be missed. Worth reporting.",
              }
            : {
                ok: false,
                text:
                  "No chat box found on screen at all. The plugin has never seen one this session, so either chat " +
                  "is closed or the plugin is looking for the wrong thing. Worth reporting.",
              };

  const buffCount = buffs.length + debuffs.length;
  const buffVerdict =
    buffCount > 0
      ? { ok: true, text: `Reading ${buffCount} buff${buffCount === 1 ? "" : "s"} on the bar.` }
      : diag.buffIconDraws === 0
        ? {
            ok: false,
            text:
              "The game is not reporting any icon draws at all, so no buff can ever be seen. This is a plugin-side " +
              "problem, not a setting. Worth reporting.",
          }
        : {
            ok: false,
            text:
              `${diag.buffIconDraws} icons were drawn last tick and none of them read as a buff. If your buff bar ` +
              "is empty that is correct; if a buff is showing right now, detection is not matching it.",
          };

  return (
    <div class="diag">
      <h3 class="diag__head">Chat</h3>
      <p class={`diag__verdict diag__verdict--${chatVerdict.ok ? "ok" : "bad"}`}>{chatVerdict.text}</p>
      <dl class="diag__grid">
        <dt>Anchors found</dt>
        <dd>{diag.chatBubbles}</dd>
        <dt>Confirmed as chat</dt>
        <dd>{diag.chatConfirmed}</dd>
        <dt>Scrolled up</dt>
        <dd>{diag.chatScrolledBoxes}</dd>
        <dt>Messages last tick</dt>
        <dd>{diag.chatLines}</dd>
      </dl>
      {diag.chatAnchors.length > 0 ? (
        <ul class="diag__list">
          {diag.chatAnchors.map((a) => (
            <li key={a.at}>
              {a.at} — {a.ischat ? (a.scrolled ? "chat, scrolled up" : "chat, reading") : "not chat"}
              <span style="color: #6b7484">
                {" "}
                (batch {a.event}, sprite {a.sprite})
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p class="diag__note">
        An anchor is an 11×11 image, which is a loose filter. The quick-chat icon beside a player's
        name is the same size, so it reads as a box of its own — harmless now that a newly-seen anchor
        no longer replays the log, but it inflates this count. Two anchors sharing a batch are one
        chat box; different sprites are different images wearing the same size.
      </p>

      <h3 class="diag__head">Buffs</h3>
      <p class={`diag__verdict diag__verdict--${buffVerdict.ok ? "ok" : "bad"}`}>{buffVerdict.text}</p>
      <dl class="diag__grid">
        <dt>Buffs read</dt>
        <dd>{buffs.length}</dd>
        <dt>Debuffs read</dt>
        <dd>{debuffs.length}</dd>
        {/*
          Each buff read is shown with its timer, because whether ANY buff
          carries a number is the single reading that says whether the vendored
          module's text parsing works here at all. It decides between "the timer
          font is unreadable" and "the timer is never even looked at", which need
          completely different fixes, and it was only ever visible by opening the
          buff picker.
        */}
        <dt>Timers read</dt>
        <dd>
          {buffs.concat(debuffs).length === 0
            ? "—"
            : buffs
                .concat(debuffs)
                .map((b) => (b.timeLeft === null ? `${b.id} none` : `${b.id} ${b.timeLeft}s`))
                .join(", ")}
        </dd>
        <dt>Icons drawn</dt>
        <dd>{diag.buffIconDraws}</dd>
        <dt>Buffs on the bar</dt>
        <dd>{diag.buffOutlines}</dd>
        {/*
          WHICH PATH FOUND EACH BUFF. The game announces a buff to plugins only
          when its icon is a rendered item model; everything else is a plain
          sprite and is found by reading the draw stream directly. The
          outlines-minus-buffs difference below gives the size of what is still
          missed, but only in aggregate — this says it per buff, which is what
          turns "detection is not seeing my familiar" into a specific claim.
        */}
        <dt>Found via</dt>
        <dd>
          {buffs.concat(debuffs).length === 0
            ? "—"
            : `${buffs.concat(debuffs).filter((b) => b.source === "icon").length} as item models, ` +
              `${buffs.concat(debuffs).filter((b) => b.source === "sprite").length} as sprites`}
        </dd>
        <dt>Pairing attempts</dt>
        <dd>{diag.buffPairAttempts}</dd>
      </dl>
      {/*
        Every buff on the bar is outlined, so this difference is what is still
        missed after BOTH paths have run — the icon path for buffs the game
        announces, and the sprite path for the ones it does not. It used to be
        the size of a structural blind spot; now a difference here is a gap
        worth reporting rather than a known limitation.
      */}
      {diag.buffOutlines > 0 && diag.buffOutlines > buffs.length + debuffs.length ? (
        <p class="diag__note">
          {diag.buffOutlines} buffs are on the bar but only {buffs.length + debuffs.length} can be
          seen. Both detection paths have run, so this is a gap rather than a limitation — if a buff
          is plainly showing and missing here, that is worth reporting.
        </p>
      ) : null}
      {diag.buffUnpaired.length > 0 ? (
        <ul class="diag__list">
          {/*
            NOT "its timer never arrived", WHICH WAS A GUESS AND A WRONG ONE. A
            buff with no countdown still reads: the module returns valid with a
            nil number (modules/buffs/buffs.lua:73,89). Declining an icon means
            it could not find the buff OUTLINE where it was told to look, or the
            outline was not one of its two colours, or a glyph would not resolve
            — none of which is a missing timer. The message now says only what is
            known, and carries the module's own error when there was one.
          */}
          {diag.buffUnpaired.map((u) => (
            <li key={`${u.id}@${u.x},${u.y}`}>
              {u.id} at {u.x},{u.y} — drawn, but not recognised as a buff
              {u.count > 1 ? ` (${u.count}× this tick)` : ""}
              {u.err === null ? "" : `: ${u.err}`}
            </li>
          ))}
        </ul>
      ) : null}
      {diag.buffIdentities.length > 0 ? (
        <>
          <p class="diag__note">
            Sprite-drawn buffs are identified by hashing their icon, because the game repacks its
            texture atlas every session. If an id here changes without the buff changing — after an
            interface rescale, say — every alert bound to it stops matching, and this is the one
            place that would show it.
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
      <p class="diag__note">
        “Icons drawn” counts every icon the game drew, inventory included — not just buff icons. It is here to
        answer one question: whether the plugin is being told about icons at all.
      </p>

      <h3 class="diag__head">XP</h3>
      <p class={`diag__verdict diag__verdict--${diag.xpCounterFound && !diag.xpCoarse ? "ok" : "bad"}`}>
        {!diag.xpCounterFound
          ? "The XP counter is not on screen, so no XP can be read and XP alerts will show no data. " +
            "Open it in game — XP is read from its totals, not from the floating +N drops, because a " +
            "drop lingers for about five seconds after XP really stops."
          : diag.xpCoarse
            ? "The XP counter is showing an abbreviated total such as 37.1M, which only moves on a gain " +
              "of tens of thousands — too coarse to tell activity from inactivity. Widen the counter so " +
              "it shows the full number."
            : `Reading ${diag.xpCells.length} row${diag.xpCells.length === 1 ? "" : "s"} from the XP counter.`}
      </p>
      <dl class="diag__grid">
        <dt>Counter found</dt>
        <dd>{diag.xpCounterFound ? "yes" : "no"}</dd>
        {/*
          The RAW cell text, because a misread number is otherwise invisible: a
          total that is wrong but plausible looks exactly like a total that is
          right, and every alerter only diffs it.
        */}
        <dt>XP column read</dt>
        <dd>{diag.xpCells.length === 0 ? "—" : diag.xpCells.join(", ")}</dd>
      </dl>
      <p class="diag__note">
        Only the total is available. A row is identified by its skill icon, and reading that is not
        built yet — so an alert naming a specific skill shows no data rather than quietly watching
        everything. While you are doing one activity, Total is the same thing.
      </p>

      <h3 class="diag__head">Action bar</h3>
      <p class={`diag__verdict diag__verdict--${diag.barsRead > 0 ? "ok" : "bad"}`}>
        {diag.barsRead === 0
          ? "None of the four resource bars were read. Health, prayer and summoning will read as full and " +
            "adrenaline as empty, so alerts watching them cannot fire."
          : `Reading ${diag.barsRead} of 4 resource bars.`}
      </p>
      <dl class="diag__grid">
        <dt>Bars read</dt>
        <dd>{diag.barsRead} / 4</dd>
        {/*
          THE VALUES, NOT JUST THE COUNT, because "4 of 4 read" and "4 of 4 read
          CORRECTLY" are different claims and only one of them is checked here.
          Identification is confirmed from a measurement; the fill geometry is
          not — every bar in every reading so far was drawn at full width because
          the player happened to be at full everything, which looks identical to a
          fixed-width bar whose value lives elsewhere. Glance at this once while
          damaged: if health does not move, FILL_W in lua/detect/stats.lua is what
          to check. Reading a permanent 100% would silence low-health alerts,
          which is worse than reading nothing.
        */}
        <dt>Levels</dt>
        <dd>
          {stats === null
            ? "— (bars never read)"
            : `hp ${Math.round(stats.hp * 100)}%  adren ${Math.round(stats.dren * 100)}%  ` +
              `pray ${Math.round(stats.pray * 100)}%  summ ${Math.round(stats.sum * 100)}%`}
        </dd>
        <dt>Draw calls last tick</dt>
        <dd>{diag.render2dEvents}</dd>
        <dt>Of those, scanned</dt>
        <dd>{diag.render2dScanned}</dd>
      </dl>
      <p class="diag__note">
        Chat and the action bar are only scanned for the first slice of each tick — walking every image
        of every batch on every frame is what costs frames per second. Anything on screen is drawn on
        every frame, so one pass sees all of it.
      </p>

      <h3 class="diag__head">What the game actually drew</h3>
      <p class="diag__note">
        Each detector finds its target by a constant that was guessed at — chat by an 11×11 image, the
        action bar by a 106×4 one in a particular colour. A wrong guess does not read the wrong value,
        it reads nothing, which looks the same as an empty screen. This samples one tick and reports
        what was really there.
      </p>
      <p>
        <button class="btn btn--ghost" onClick={onProbe}>
          Sample one tick
        </button>
      </p>
      {probe === null ? null : (
        <>
          {/*
            A COPY BUTTON, because the report is meant to leave this window.
            It is a scrolling box of a hundred lines and the most important ones
            are at the top; selecting it by hand drops them, which is exactly
            what happened to the resource-bar readings the first time.
          */}
          <p>
            <button
              class="btn btn--ghost"
              onClick={() => {
                const target = dump.current;
                setCopied(target !== null && selectAndCopy(target) ? "ok" : "failed");
              }}
            >
              {copied === "ok" ? "Copied." : copied === "failed" ? "Selected — press Ctrl+C" : "Copy report"}
            </button>
          </p>
          <dl class="diag__grid">
            <dt>Icon draws</dt>
            <dd>{probe.icons.length}</dd>
            <dt>Distinct shapes</dt>
            <dd>{probe.shapes.length}</dd>
            <dt>Bar-shaped images</dt>
            <dd>{probe.bars.length}</dd>
          </dl>
          {probe.truncated ? (
            <p class="diag__verdict diag__verdict--bad">
              Capped — there was more than this. Enough to work from, but not a complete list.
            </p>
          ) : null}
          {/*
            THE SAME TEXT THE BUTTON COPIES, from the same builder. This used to
            be assembled separately out of `icons` and `shapes`, which dropped
            the `bars` section — the four lines the whole reading is taken for.
            The report was hand-copied off this box and arrived without them.
          */}
          <pre class="diag__dump" ref={dump}>
            {probeReport(probe)}
          </pre>
        </>
      )}
    </div>
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
        {a.error === null && awaitsDetection(a.config.type) ? (
          <span
            class="badge"
            title="Detection for this alert type is still being built, so it cannot fire yet."
          >
            not built yet
          </span>
        ) : a.error === null && !a.state.functional ? (
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
      <h2>Import presets</h2>
      <p class="fld__help">
        Paste a preset exported from here, or from AfkWarden — the format is the same, so either
        works. In AfkWarden, open the save icon, choose a preset and press Export. The whole
        <code>afkscape_presets</code> blob works too.
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
  const [diagOpen, setDiagOpen] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const saveNow = useCallback(() => {
    props.onSave();
    setJustSaved(true);
  }, [props.onSave]);

  // Clear the confirmation on its own, so it reads as an event rather than as a
  // permanent claim that everything is saved.
  useEffect(() => {
    if (!justSaved) return;
    const id = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(id);
  }, [justSaved]);

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
        <HealthPill
          connected={connected}
          character={characterName}
          chat={props.chat}
          expanded={diagOpen}
          onToggle={() => setDiagOpen((v) => !v)}
        />
      </header>

      {diagOpen ? (
        <DetectionPanel
          connected={connected}
          diag={props.diag}
          buffs={props.liveBuffs}
          debuffs={props.liveDebuffs}
          stats={props.stats}
          probe={props.probe}
          onProbe={props.onProbe}
        />
      ) : null}

      {/*
        LABELLED, not glyph-only. Every one of these was a bare symbol whose
        meaning had to be recovered by hovering and waiting for a tooltip — which
        is a cost paid on every use until the whole row is memorised, and a real
        barrier to the destructive ones being used confidently.
      */}
      <div class="subhdr">
        <button class="toolbtn" title="Create a new, empty preset" onClick={() => promptPreset("new")}>
          <span class="toolbtn__icon">🗋</span>
          New
        </button>
        <button
          class="toolbtn"
          title="Rename this preset"
          disabled={preset === null}
          onClick={() => promptPreset("rename")}
        >
          <span class="toolbtn__icon">✏</span>
          Rename
        </button>
        <button
          class="toolbtn"
          title="Copy this preset and its alerts into a new one"
          disabled={preset === null}
          onClick={() => promptPreset("duplicate")}
        >
          <span class="toolbtn__icon">⧉</span>
          Duplicate
        </button>
        <span class="toolbtn__sep" />
        <button
          class="toolbtn"
          title="Save this preset to a file you can share or keep"
          disabled={preset === null}
          onClick={() => setExporting(preset)}
        >
          <span class="toolbtn__icon">⬆</span>
          Export
        </button>
        <button
          class="toolbtn"
          title="Load presets from an AfkWarden or AFK Goblin export"
          onClick={() => setImportOpen(true)}
        >
          <span class="toolbtn__icon">⬇</span>
          Import
        </button>
        <button
          class="toolbtn toolbtn--danger"
          title="Delete this preset and every alert in it"
          disabled={preset === null}
          onClick={() => {
            if (preset === null) return;
            if (globalThis.confirm(`Delete preset “${preset.name}”?`)) {
              props.onPresetAction({ kind: "delete" });
            }
          }}
        >
          <span class="toolbtn__icon">🗑</span>
          Delete
        </button>
        <span class="ftr__spacer" />
        <button
          class="toolbtn toolbtn--accent"
          title="Add a new alert to this preset"
          disabled={preset === null}
          onClick={() => setEditing({ index: null })}
        >
          <span class="toolbtn__icon">＋</span>
          Add alert
        </button>
      </div>

      {/*
        SAVING IS AUTOMATIC, and that is worth saying out loud rather than
        leaving to be inferred. Every edit already writes to local storage and to
        the plugin's own config file; someone with no way to check that reasonably
        assumes their work is unsaved and goes looking for a button. This is that
        button — it forces the write and confirms it, so the answer to "did that
        save?" is one click rather than a restart.
      */}
      <div class="saveline">
        <button class="btn btn--ghost" onClick={saveNow} disabled={preset === null}>
          Save now
        </button>
        <span class={`saveline__note${justSaved ? " saveline__note--ok" : ""}`}>
          {justSaved ? "Saved." : "Changes save automatically as you make them."}
        </span>
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
              Import presets
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
        liveBuffs={props.liveBuffs}
        liveDebuffs={props.liveDebuffs}
        buffIconDraws={props.diag?.buffIconDraws ?? 0}
        recentChat={props.recentChat}
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
