import { describe, expect, it } from "vitest";
import { applyDrop, groupsOf, renameGroup } from "~/engine/reorder";
import { AlerterBaseSchema, type AlerterBase } from "~/store/schema";

const a = (name: string, group: string | null = null): AlerterBase =>
  AlerterBaseSchema.parse({ name, type: "inactive", group, vars: { delay: 10 } });

const names = (list: readonly AlerterBase[]) => list.map((x) => x.name);
const groups = (list: readonly AlerterBase[]) => list.map((x) => x.group);

describe("applyDrop reordering", () => {
  const list = [a("A"), a("B"), a("C"), a("D")];

  it("moves an alert down", () => {
    expect(names(applyDrop(list, 0, { kind: "at", index: 3 }))).toEqual(["B", "C", "A", "D"]);
  });

  it("moves an alert up", () => {
    expect(names(applyDrop(list, 3, { kind: "at", index: 1 }))).toEqual(["A", "D", "B", "C"]);
  });

  it("moves to the very top", () => {
    expect(names(applyDrop(list, 2, { kind: "at", index: 0 }))).toEqual(["C", "A", "B", "D"]);
  });

  it("moves to the very end", () => {
    expect(names(applyDrop(list, 0, { kind: "at", index: 4 }))).toEqual(["B", "C", "D", "A"]);
  });

  it("does not mutate the input", () => {
    const original = [...list];
    applyDrop(list, 0, { kind: "at", index: 3 });
    expect(names(list)).toEqual(names(original));
  });

  it("ignores an out-of-range source", () => {
    expect(names(applyDrop(list, 9, { kind: "at", index: 0 }))).toEqual(names(list));
  });
});

describe("applyDrop grouping", () => {
  it("joins the group when dropped onto a grouped alert", () => {
    const list = [a("A"), a("B", "Waves"), a("C", "Waves")];
    const out = applyDrop(list, 0, { kind: "onto", index: 1 });
    expect(names(out)).toEqual(["B", "A", "C"]);
    expect(out.find((x) => x.name === "A")!.group).toBe("Waves");
  });

  // Grouping two loose alerts has to name both of them, not just the dragged one.
  it("creates a group when dropped onto an ungrouped alert", () => {
    const list = [a("A"), a("B"), a("C")];
    const out = applyDrop(list, 2, { kind: "onto", index: 0 });
    expect(names(out)).toEqual(["A", "C", "B"]);
    expect(out[0]!.group).toBe("Group");
    expect(out[1]!.group).toBe("Group");
    expect(out[2]!.group).toBeNull();
  });

  it("does not reuse an existing group name when creating one", () => {
    const list = [a("A", "Group"), a("B"), a("C")];
    const out = applyDrop(list, 2, { kind: "onto", index: 1 });
    expect(out.find((x) => x.name === "B")!.group).toBe("Group 2");
  });

  it("is a no-op when dropped onto itself", () => {
    const list = [a("A"), a("B")];
    expect(names(applyDrop(list, 0, { kind: "onto", index: 0 }))).toEqual(["A", "B"]);
  });

  it("joins a group when dropped between two of its members", () => {
    const list = [a("A"), a("B", "Waves"), a("C", "Waves")];
    const out = applyDrop(list, 0, { kind: "at", index: 2 });
    expect(names(out)).toEqual(["B", "A", "C"]);
    expect(out[1]!.group).toBe("Waves");
  });

  // This is what makes "drag it out" work without a separate gesture.
  it("leaves the group when dropped at a boundary", () => {
    const list = [a("A", "Waves"), a("B", "Waves"), a("C")];
    const out = applyDrop(list, 0, { kind: "at", index: 3 });
    expect(names(out)).toEqual(["B", "C", "A"]);
    expect(out[2]!.group).toBeNull();
  });

  it("stays ungrouped when dropped between two ungrouped alerts", () => {
    const list = [a("A"), a("B"), a("C", "Waves")];
    const out = applyDrop(list, 2, { kind: "at", index: 1 });
    expect(groups(out)).toEqual([null, null, null]);
  });

  it("keeps groups contiguous when an alert leaves the middle", () => {
    const list = [a("A", "G"), a("B", "G"), a("C", "G"), a("D")];
    const out = applyDrop(list, 1, { kind: "at", index: 4 });
    expect(names(out)).toEqual(["A", "C", "D", "B"]);
    expect(groups(out)).toEqual(["G", "G", null, null]);
  });
});

describe("groupsOf", () => {
  it("lists distinct groups in first-appearance order", () => {
    expect(groupsOf([a("A", "Z"), a("B"), a("C", "Y"), a("D", "Z")])).toEqual(["Z", "Y"]);
  });

  it("is empty when nothing is grouped", () => {
    expect(groupsOf([a("A"), a("B")])).toEqual([]);
  });
});

/**
 * LEAVING A GROUP WITHOUT MOVING.
 *
 * Reported in game: "to remove an alert from a group by dragging, its location
 * has to be changed". With a two-alert group, dragging the lower one down lands
 * it at the same index — but past the end of the group, which is exactly the
 * gesture for getting out.
 */
describe("applyDrop leaving a group without changing position", () => {
  it("ungroups the lower member of a trailing pair dragged down", () => {
    const list = [a("Familiar timer", "Group"), a("Reservoir", "Group")];

    const out = applyDrop(list, 1, { kind: "at", index: 2 });

    expect(names(out)).toEqual(["Familiar timer", "Reservoir"]);
    expect(groups(out)).toEqual(["Group", null]);
  });

  it("ungroups the upper member of a trailing pair dragged up", () => {
    const list = [a("Familiar timer", "Group"), a("Reservoir", "Group")];

    const out = applyDrop(list, 0, { kind: "at", index: 0 });

    expect(names(out)).toEqual(["Familiar timer", "Reservoir"]);
    expect(groups(out)).toEqual([null, "Group"]);
  });

  it("ungroups the lower member when an ungrouped alert follows", () => {
    const list = [a("Familiar timer", "Group"), a("Reservoir", "Group"), a("Other")];

    const out = applyDrop(list, 1, { kind: "at", index: 2 });

    expect(names(out)).toEqual(["Familiar timer", "Reservoir", "Other"]);
    expect(groups(out)).toEqual(["Group", null, null]);
  });

  it("keeps a middle member grouped when it lands back between two of its group", () => {
    const list = [a("A", "G"), a("B", "G"), a("C", "G")];

    const out = applyDrop(list, 1, { kind: "at", index: 2 });

    expect(names(out)).toEqual(["A", "B", "C"]);
    expect(groups(out)).toEqual(["G", "G", "G"]);
  });
});
/**
 * A group is not an entity — it is a name repeated on a contiguous run — so a
 * rename is a sweep. Renaming alert by alert through the editor would leave the
 * run split under two names partway through, which reads as the group having been
 * torn in half.
 */
describe("renameGroup", () => {
  it("renames every alert carrying the old name", () => {
    const list = [a("A", "G"), a("B", "G"), a("C"), a("D", "H")];

    const out = renameGroup(list, "G", "Combat");

    expect(groups(out)).toEqual(["Combat", "Combat", null, "H"]);
    expect(names(out)).toEqual(["A", "B", "C", "D"]);
  });

  it("leaves alerts outside the group untouched by identity", () => {
    const list = [a("A", "G"), a("C")];

    const out = renameGroup(list, "G", "Combat");

    expect(out[1]).toBe(list[1]);
  });

  it("ignores an empty or unchanged name rather than ungrouping by stealth", () => {
    const list = [a("A", "G"), a("B", "G")];

    expect(groups(renameGroup(list, "G", "   "))).toEqual(["G", "G"]);
    expect(groups(renameGroup(list, "G", "G"))).toEqual(["G", "G"]);
  });

  it("merges into an existing group when renamed onto its name", () => {
    const list = [a("A", "G"), a("B", "H")];

    expect(groups(renameGroup(list, "G", "H"))).toEqual(["H", "H"]);
  });

  it("trims the new name", () => {
    const list = [a("A", "G")];

    expect(groups(renameGroup(list, "G", "  Combat  "))).toEqual(["Combat"]);
  });
});