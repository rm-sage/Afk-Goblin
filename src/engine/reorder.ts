import type { AlerterBase } from "~/store/schema";

export type DropTarget =
  /** Land at this index, pushing whatever was there down. */
  | { kind: "at"; index: number }
  /** Land directly under this alert and share its group. */
  | { kind: "onto"; index: number };

export const DEFAULT_GROUP_NAME = "Group";

function uniqueGroupName(alerts: readonly AlerterBase[], base = DEFAULT_GROUP_NAME): string {
  const taken = new Set(alerts.map((a) => a.group).filter((g): g is string => g !== null));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Move an alert, deciding its group from where it lands.
 *
 * Groups are contiguous runs rather than a separate tree, which keeps the data
 * model flat and the rules predictable:
 *
 *  - dropping BETWEEN two alerts of the same group joins that group;
 *  - dropping at any other boundary leaves the alert ungrouped, which is what
 *    makes "drag it out" work without a separate ungroup gesture;
 *  - dropping ONTO an alert joins its group, creating one if it had none.
 *
 * Returns a new array; the input is not mutated.
 */
export function applyDrop(
  alerts: readonly AlerterBase[],
  from: number,
  target: DropTarget,
): AlerterBase[] {
  if (from < 0 || from >= alerts.length) return [...alerts];

  const moving = alerts[from]!;
  const rest = alerts.filter((_, i) => i !== from);

  // A DROP THAT DOES NOT MOVE THE ALERT CAN STILL CHANGE ITS GROUP. Landing at
  // the same index is not "nothing happened": with a two-alert group, dragging the
  // lower one down leaves it where it was but puts it past the end of the group,
  // which is the gesture for getting out. The rules below decide the group from
  // the NEIGHBOURS rather than from whether the index moved, so they handle it —
  // as long as nothing short-circuits before they run.

  if (target.kind === "onto") {
    if (target.index === from) return [...alerts];

    const anchor = alerts[target.index];
    if (anchor === undefined) return [...alerts];

    // Creating a group has to name both members, not just the one being dragged.
    let group = anchor.group;
    let renamedAnchor: AlerterBase | null = null;
    if (group === null) {
      group = uniqueGroupName(alerts);
      renamedAnchor = { ...anchor, group };
    }

    const out = rest.map((a) => (a === anchor && renamedAnchor !== null ? renamedAnchor : a));
    const anchorAt = out.findIndex((a) => a === (renamedAnchor ?? anchor));
    out.splice(anchorAt + 1, 0, { ...moving, group });
    return out;
  }

  // Clamp into the post-removal array so an index taken from the pre-move list
  // still lands where the user pointed.
  const insertAt = Math.max(0, Math.min(rest.length, from < target.index ? target.index - 1 : target.index));

  const prev = rest[insertAt - 1] ?? null;
  const next = rest[insertAt] ?? null;
  const group =
    prev !== null && next !== null && prev.group === next.group
      ? prev.group
      : prev !== null && next === null && prev.group !== null && from > insertAt
        ? // Dropping at the very end, straight after a group, reads as leaving it.
          null
        : null;

  const out = [...rest];
  out.splice(insertAt, 0, { ...moving, group });
  return out;
}

/**
 * Rename a group across every alert carrying it.
 *
 * A group is not an entity — it is a name repeated on a contiguous run of alerts —
 * so renaming one is a sweep rather than an edit to a single record. That is also
 * why it has to be done in one pass: renaming alert by alert through the editor
 * leaves the run split under two names partway through, which reads as the group
 * having been torn in half.
 *
 * MERGING IS THE CALLER'S PROBLEM, not a special case here. Renaming onto a name
 * already in use joins the two, which is what the words on screen would then say;
 * whether the runs are adjacent is a layout question the list already answers.
 *
 * Returns a new array; the input is not mutated. Alerts that do not carry the old
 * name are returned by identity, so nothing else is rebuilt downstream.
 */
export function renameGroup(
  alerts: readonly AlerterBase[],
  from: string,
  to: string,
): AlerterBase[] {
  const name = to.trim();
  if (name.length === 0 || name === from) return [...alerts];
  return alerts.map((a) => (a.group === from ? { ...a, group: name } : a));
}

/** Group names still in use, in the order they first appear. */
export function groupsOf(alerts: readonly AlerterBase[]): string[] {
  return [...new Set(alerts.map((a) => a.group).filter((g): g is string => g !== null))];
}
