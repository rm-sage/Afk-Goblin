import { z } from "zod";
import { clamp01, defineAlerter, type AlerterContext, type TriggerState } from "~/engine/types";

export const InactiveVars = z.object({
  /** Seconds of no RS interaction before triggering. AfkWarden's lobby default is 570. */
  delay: z.number().int().positive().default(570),
  /**
   * Also count mouse movement over the client as activity, not just clicks.
   *
   * RuneScape itself treats hovering as activity, so this makes the timer match
   * what the game considers idle. It defaults OFF because the failure modes are
   * asymmetric: counting clicks only can warn you early, which costs a wasted
   * glance, while counting movement can warn you late, which costs the logout the
   * alert existed to prevent.
   */
  countMouseMovement: z.boolean().default(false),
});

export type InactiveVars = z.infer<typeof InactiveVars>;

/**
 * Triggers when the RS window has not been clicked for `delay` seconds.
 *
 * The canonical use is the lobby timer: RuneScape disconnects an idle client, so
 * this fires just before that happens.
 */
export const inactiveAlerter = defineAlerter<InactiveVars>({
  type: "inactive",
  typename: "Inactive",
  descr:
    "Triggers when you have not clicked the RuneScape window for a set amount of time.",
  schema: InactiveVars,
  fields: [
    { key: "delay", kind: "number", label: "Alert after", min: 1, suffix: "sec" },
    {
      key: "countMouseMovement",
      kind: "boolean",
      label: "Count mouse movement as activity",
      help: "RuneScape treats hovering as activity. Off by default: counting it can warn you late, and warning late is the one failure this alert must not have.",
    },
  ],
  create(vars) {
    return {
      check(ctx: AlerterContext): TriggerState {
        // Without Gamestate, idleMs carries no information. Say so rather than
        // reporting a confident "not idle" that would never fire.
        if (!ctx.connected) {
          return { triggered: false, bar: 0, functional: false };
        }

        // Whichever happened more recently defines how idle you actually are.
        const idleMs = vars.countMouseMovement
          ? Math.min(ctx.idleMs, ctx.mouseIdleMs)
          : ctx.idleMs;

        const targetMs = vars.delay * 1000;
        return {
          triggered: idleMs >= targetMs,
          bar: clamp01(idleMs / targetMs),
          functional: true,
        };
      },
    };
  },
});
