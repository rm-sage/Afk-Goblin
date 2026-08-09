import { useEffect, useRef } from "preact/hooks";
import type { BuffSlot, ChatLine, RGB } from "~/engine/types";

function rgbCss(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Describe a buff in terms a human can match against their own screen.
 *
 * The id is a discovered signature ("2:1344"), which is stable and unique but
 * meaningless to read. What actually lets someone tell one buff from another in
 * this list is its remaining time and stack count — the same numbers showing on
 * the bar right now.
 */
function describeBuff(b: BuffSlot): string {
  const parts: string[] = [];
  if (b.timeLeft !== null) parts.push(`${b.timeLeft}s left`);
  if (b.stacks !== null) parts.push(`${b.stacks} stacks`);
  if (parts.length === 0) parts.push("no timer showing");
  return parts.join(", ");
}

/* ============================== buff picker ============================== */

export type BuffPickerProps = {
  open: boolean;
  isDebuff: boolean;
  /** Buffs currently on the bar, as pushed by the plugin. */
  buffs: readonly BuffSlot[];
  /**
   * Every icon the game drew last tick, inventory included — not just buff
   * icons, because nothing distinguishes them before the details are parsed.
   * Diagnostic only: a zero means the plugin is being told about no icons at
   * all, so no buff could ever appear here however many are on the bar.
   */
  iconDraws: number;
  onPick(buffId: string): void;
  onClose(): void;
};

/**
 * Pick a buff to watch by choosing one that is currently active.
 *
 * The intent is unchanged from the Alt1 version — show what is really on the bar
 * rather than asking the user to describe a buff — but the mechanism is not.
 * Alt1 stored the captured PIXELS and matched them later, so a template could
 * decay until it stopped matching. What is stored now is a signature derived
 * from the buff's icon model, which cannot drift because nothing rewrites it.
 *
 * The practical consequence is that a buff must be ACTIVE to be picked. That is
 * a real limitation, and the dialog says so rather than showing an empty list
 * with no explanation.
 */
/**
 * Buffs in the order they sit on the bar, left to right.
 *
 * Ids are opaque by construction — a model signature, or a hash of the icon's
 * pixels — so position is the only handle a person has on which entry is which.
 * Sorting the list to match the screen is what makes "the third one along"
 * usable as an instruction.
 *
 * Slot 0 means the position is unknown: an older plugin, or a buff whose x was
 * never read. Those go LAST, because sorting them numerically would float them
 * to the top and claim they are leftmost — a confident answer to a question that
 * has none.
 */
export function orderBuffsForPicker(buffs: readonly BuffSlot[]): BuffSlot[] {
  return [...buffs].sort((a, b) => {
    if (a.slot === 0 || b.slot === 0) return (a.slot === 0 ? 1 : 0) - (b.slot === 0 ? 1 : 0);
    return a.slot - b.slot;
  });
}

export function BuffPicker({
  open,
  isDebuff,
  buffs,
  iconDraws,
  onPick,
  onClose,
}: BuffPickerProps) {
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
        Showing the {what}s active right now, in the order they sit on your bar — #1 is the
        leftmost. Apply the one you want to watch, then pick it here; it only needs to be active
        while you choose it, not afterwards. Name the alert itself to remember which is which.
      </p>

      {buffs.length === 0 ? (
        <p class="fld__help">
          No {what}s are active. Apply one in game and this list will fill in.
          {iconDraws === 0 ? (
            <>
              {" "}
              <strong>The plugin is not being told about any icon draws either</strong> — which is
              normal if nothing on your bar is a potion or a charged item, since everything else is
              found by reading the screen instead. Open the detection panel if a {what} is showing
              and still missing here.
            </>
          ) : null}
        </p>
      ) : (
        <ul class="issues">
          {orderBuffsForPicker(buffs).map((b) => (
            <li key={b.id}>
              <button class="btn btn--ghost" onClick={() => onPick(b.id)}>
                {b.slot > 0 ? `#${b.slot} on the bar — ` : ""}
                {describeBuff(b)}
                <span style="color: #888"> ({b.id})</span>
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
