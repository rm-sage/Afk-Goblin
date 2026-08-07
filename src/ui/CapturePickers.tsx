import { useEffect, useRef } from "preact/hooks";
import type { BuffSlot, ChatLine, RGB } from "~/engine/types";

function rgbCss(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Turn "spiritattractionpotion" into something readable without a lookup table. */
function prettyBuffName(id: string): string {
  return id.replace(/^./, (c) => c.toUpperCase());
}

/* ============================== buff picker ============================== */

export type BuffPickerProps = {
  open: boolean;
  isDebuff: boolean;
  /** Buffs currently on the bar, as pushed by the plugin. */
  buffs: readonly BuffSlot[];
  onPick(buffId: string): void;
  onClose(): void;
};

/**
 * Pick a buff to watch by choosing one that is currently active.
 *
 * The intent is unchanged from the Alt1 version — show what is really on the bar
 * rather than asking the user to describe a buff — but the mechanism is not.
 * Alt1 stored the captured PIXELS and matched them later, so what you picked was
 * literally what got matched. Bolt identifies buffs by name against the game's
 * own texture atlas, so what is stored is an id and matching cannot drift.
 *
 * The practical consequence is that a buff must be ACTIVE to be picked. That is
 * a real limitation, and the dialog says so rather than showing an empty list
 * with no explanation.
 */
export function BuffPicker({ open, isDebuff, buffs, onPick, onClose }: BuffPickerProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const what = isDebuff ? "debuff" : "buff";

  return (
    <dialog ref={ref} onCancel={onClose}>
      <h2>Pick a {what}</h2>
      <p class="fld__help">
        Showing the {what}s active right now. Apply the one you want to watch, then pick it here —
        it only needs to be active while you choose it, not afterwards.
      </p>

      {buffs.length === 0 ? (
        <p class="fld__help">
          No {what}s are active. Apply one in game and this list will fill in.
        </p>
      ) : (
        <ul class="issues">
          {buffs.map((b) => (
            <li key={b.id}>
              <button class="btn btn--ghost" onClick={() => onPick(b.id)}>
                {prettyBuffName(b.id)}
                {b.timeLeft !== null ? ` — ${b.timeLeft}s` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div class="dlg__actions">
        <button class="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

/* ============================== chat picker ============================== */

export type ChatPickerProps = {
  open: boolean;
  /** Lines seen recently, newest last. */
  lines: readonly ChatLine[];
  chosen: string[];
  onPick(text: string, colors: RGB[]): void;
  onClose(): void;
};

/**
 * Pick trigger text by clicking a line that actually happened.
 *
 * Typing trigger text by hand means guessing at the game's exact wording and
 * punctuation, and a near miss fails silently. Clicking a real line cannot be
 * misspelled, and its colours come along automatically.
 */
export function ChatPicker({ open, lines, chosen, onPick, onClose }: ChatPickerProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const already = new Set(chosen);

  return (
    <dialog ref={ref} onCancel={onClose}>
      <h2>Pick a chat line</h2>
      <p class="fld__help">
        The most recent lines the plugin has seen. Clicking one adds its text and its colours
        together — a line only matches alongside the colours it was written in.
      </p>

      {lines.length === 0 ? (
        <p class="fld__help">No chat lines seen yet. They appear here as they arrive.</p>
      ) : (
        <ul class="issues">
          {[...lines].reverse().map((l, i) => (
            <li key={`${i}-${l.text}`}>
              <button
                class="btn btn--ghost"
                disabled={already.has(l.text)}
                style={l.colors[0] !== undefined ? { color: rgbCss(l.colors[0]) } : undefined}
                onClick={() => onPick(l.text, [...l.colors])}
              >
                {l.text}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div class="dlg__actions">
        <button class="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
