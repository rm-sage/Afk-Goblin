/**
 * The draw-stream report as text, and getting it out of the window.
 *
 * ITS OWN MODULE BECAUSE BOTH HALVES HAVE FAILED IN THE FIELD, SILENTLY.
 *
 * The report only has a purpose somewhere else — in a conversation, next to the
 * source that is supposed to explain it. A report that cannot leave the window
 * is a report that was never taken, and that is not a hypothetical: an
 * in-game session was spent on an action bar that reads zero of four bars while
 * the probe was already reporting the four bar images' colours, and neither the
 * screen nor the clipboard carried them out. Both paths are now one function
 * with tests around it.
 */
import type { ProbeMessage } from "~/bolt-io/protocol";

/** Just the parts of a report that get rendered, so tests need not build a whole message. */
export type Reportable = Pick<ProbeMessage, "bars" | "icons" | "shapes" | "texts" | "truncated">;

/**
 * The report as text: bars first, then icons, then shapes.
 *
 * BARS FIRST AND NEVER OMITTED. They are four lines out of a hundred and they
 * are the whole reason to take a reading — the other two sections are context
 * for them. This function used to have a twin that built the on-screen dump from
 * `icons` and `shapes` alone, so what was displayed silently lacked the only
 * section anyone was waiting for. There is one builder now, and the screen and
 * the clipboard both call it, because that was the invariant the twin claimed to
 * uphold and did not.
 */
export function probeReport(probe: Reportable): string {
  return [
    ...probe.bars.map(
      (b) => `bar ${b.atlas} at ${b.x},${b.y} drawn ${b.drawn}px  texture ${b.texture}  tint ${b.tint}`,
    ),
    // TEXT FIRST, because it is the only section that names what an interface
    // says. Reading the XP counter needs its header strings, its column order and
    // its number format, and all three were about to be guessed at.
    ...probe.texts.map((t) => `text "${t.text}" at ${t.x},${t.y} ${t.w}x${t.h} batch ${t.event}`),
    ...probe.icons.map((i) => `icon ${i.id ?? "unreadable"} at ${i.x},${i.y} ${i.w}x${i.h}`),
    ...probe.shapes.map((s) => `${s.count}x ${s.key} first at ${s.x},${s.y}`),
    probe.truncated ? "(capped — there was more than this)" : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The least a DOM node has to offer for {@link selectAndCopy}. A real
 * `HTMLElement` satisfies it; so does a fake, which is how this is tested in a
 * `node` environment with no DOM at all.
 */
export type CopyTarget = {
  ownerDocument: {
    createRange(): { selectNodeContents(node: never): void };
    execCommand(command: string): boolean;
    defaultView: { getSelection(): { removeAllRanges(): void; addRange(range: never): void } | null } | null;
  } | null;
};

/**
 * Select a node's rendered text and copy it, returning whether the copy landed.
 *
 * NOT `navigator.clipboard`, AND THIS IS THE FIX RATHER THAN A STYLE CHOICE.
 * The Clipboard API is gated on a secure context. Bolt serves this UI from
 * `plugin://app/index.html` (see UI_URL in main.lua), a custom scheme CEF does
 * not treat as secure, so `navigator.clipboard` is not merely permission-denied
 * there — it is `undefined`. Reading `.writeText` off it threw a TypeError
 * synchronously, which also skipped the line after it that set the button to
 * "Copied.", so the only symptom was a button that did nothing at all.
 * `execCommand` is deprecated but has no secure-context requirement and is what
 * still works here.
 *
 * FAILURE LEAVES THE TEXT SELECTED, ON PURPOSE. If `execCommand` is eventually
 * removed too, the selection this made is still sitting on screen and Ctrl+C
 * takes it. The degraded path is a working one rather than another dead button.
 */
export function selectAndCopy(node: CopyTarget): boolean {
  const doc = node.ownerDocument;
  const selection = doc?.defaultView?.getSelection() ?? null;
  if (doc == null || selection == null) return false;

  const range = doc.createRange();
  range.selectNodeContents(node as never);
  selection.removeAllRanges();
  selection.addRange(range as never);

  try {
    return doc.execCommand("copy");
  } catch {
    return false;
  }
}
