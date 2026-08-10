import { z } from "zod";
import { clamp01, defineAlerter, type AlerterContext, type TriggerState } from "~/engine/types";

export const ACTIONBAR_STATS = ["hp", "pray", "sum", "dren"] as const;
export type ActionbarStat = (typeof ACTIONBAR_STATS)[number];

export const ActionbarVars = z.object({
  stat: z.enum(ACTIONBAR_STATS).default("hp"),
  higherlower: z.enum(["higher", "lower"]).default("lower"),
  /** Percentage, 0..100. Stored as `treshold` in AfkWarden; normalised on import. */
  threshold: z.number().min(0).max(100).default(20),
});

export type ActionbarVars = z.infer<typeof ActionbarVars>;

/**
 * Watches a resource on the action bar and fires when it crosses a threshold.
 *
 * Reader values are fractions (0..1) while the threshold is a percentage, matching
 * AfkWarden's stored shape so imported alerts keep their meaning.
 *
 * For a "lower" alert the bar fills as the resource DRAINS: the bar tracks progress
 * toward the alert firing, not the size of the resource.
 */
export const actionbarAlerter = defineAlerter<ActionbarVars>({
  type: "actionbar",
  typename: "Action bar stats",
  descr:
    "Triggers when your life points, prayer, summoning or adrenaline pass a threshold.",
  schema: ActionbarVars,
  fields: [
    {
      key: "stat",
      kind: "select",
      label: "Resource",
      options: [
        { value: "hp", label: "Life points" },
        { value: "pray", label: "Prayer" },
        { value: "sum", label: "Summoning" },
        { value: "dren", label: "Adrenaline" },
      ],
    },
    {
      key: "higherlower",
      kind: "select",
      label: "Trigger when",
      options: [
        { value: "lower", label: "At or below" },
        { value: "higher", label: "At or above" },
      ],
    },
    { key: "threshold", kind: "number", label: "Threshold", min: 0, max: 100, suffix: "%" },
  ],
  create(vars) {
    return {
      check(ctx: AlerterContext): TriggerState {
        const state = ctx.state.stats;
        if (state === null) {
          return { triggered: false, bar: 0, functional: false };
        }

        // THE ONE BAR THIS ALERT WATCHES, not the action bar in general. A bar
        // whose colour never resolves is null while its neighbours read fine, and
        // reporting a plausible number for it instead is how an "HP at or below
        // 25%" alert came to sit silent at `functional: true` for a whole session.
        const value = state[vars.stat];
        if (value === null) {
          return { triggered: false, bar: 0, functional: false };
        }

        const threshold = vars.threshold / 100;

        if (vars.higherlower === "higher") {
          return {
            triggered: value >= threshold,
            bar: clamp01(threshold === 0 ? 1 : value / threshold),
            functional: true,
          };
        }

        return {
          triggered: value <= threshold,
          bar: clamp01(1 - value),
          functional: true,
        };
      },
    };
  },
});
