import { z } from "zod";
import { defineAlerter, type AlerterContext, type TriggerState } from "~/engine/types";

/* ============================ dialogtextsimple ============================ */

export const DialogVars = z.object({});
export type DialogVars = z.infer<typeof DialogVars>;

/**
 * Triggers while a dialog with a continue button is on screen.
 *
 * The usual use is "inventory full" and similar interruptions: anything that
 * stops what you were doing puts a dialog up.
 */
export const dialogAlerter = defineAlerter<DialogVars>({
  type: "dialogtextsimple",
  typename: "Dialog box",
  descr:
    "Triggers when any dialog with a continue button appears — inventory full, level ups, and similar interruptions.",
  schema: DialogVars,
  fields: [],
  create() {
    return {
      check(ctx: AlerterContext): TriggerState {
        const open = ctx.state.dialogOpen;
        if (open === null) {
          return { triggered: false, bar: 0, functional: false };
        }
        return { triggered: open, bar: open ? 1 : 0, functional: true };
      },
    };
  },
});

/* ============================== targetdeath =============================== */

export const TargetDeathVars = z.object({});
export type TargetDeathVars = z.infer<typeof TargetDeathVars>;

/**
 * Triggers when the mob you were fighting dies.
 *
 * Only arms once a living target has actually been seen. AfkWarden treats "no
 * target" as death unconditionally, which means the alert sits triggered before
 * you have engaged anything at all; waiting for a live target first keeps the
 * meaning ("the thing I was fighting is gone") without that false start.
 */
export const targetDeathAlerter = defineAlerter<TargetDeathVars>({
  type: "targetdeath",
  typename: "Target death",
  descr: "Triggers when the mob you are fighting dies or disappears.",
  schema: TargetDeathVars,
  fields: [],
  create() {
    let sawLiveTarget = false;

    return {
      check(ctx: AlerterContext): TriggerState {
        const target = ctx.state.target;

        if (target !== null && target.hp > 0) {
          sawLiveTarget = true;
          return { triggered: false, bar: 0, functional: true };
        }

        if (!sawLiveTarget) {
          return { triggered: false, bar: 0, functional: true };
        }

        return { triggered: true, bar: 1, functional: true };
      },
      reset() {
        sawLiveTarget = false;
      },
    };
  },
});

/* ================================= drops ================================== */

export const DropsVars = z.object({
  /** Substrings matched against drop names, as AfkWarden stores them. */
  triggerdrops: z.array(z.object({ text: z.string() })).default([]),
});

export type DropsVars = z.infer<typeof DropsVars>;

/**
 * Triggers when a matching item appears in the RuneMetrics drop log.
 *
 * Matching is a case-insensitive substring test on the drop name, which is what
 * AfkWarden does — there is no item database involved, and no network call: the
 * drop log is read off the screen.
 *
 * Clears once you click, since the alert exists to tell you something dropped
 * and acting on it is the acknowledgement.
 */
export const dropsAlerter = defineAlerter<DropsVars>({
  type: "drops",
  typename: "Item drops",
  descr: "Triggers when a named item shows up in your RuneMetrics drop log.",
  schema: DropsVars,
  fields: [
    {
      key: "triggerdrops",
      kind: "lines",
      label: "Drops that trigger this alert",
      help: "One item name per line, matched as a case-insensitive substring.",
    },
  ],
  create(vars) {
    const needles = vars.triggerdrops
      .map((d) => d.text.toLowerCase())
      .filter((t) => t.length > 0);

    let triggered = false;
    let triggeredAt = 0;

    return {
      check(ctx: AlerterContext): TriggerState {
        if (needles.length === 0) {
          return { triggered: false, bar: 0, functional: false };
        }

        const drops = ctx.state.newDrops;
        if (drops === null) {
          return { triggered, bar: triggered ? 1 : 0, functional: false };
        }

        // Both are "milliseconds since", so the smaller one happened later.
        if (triggered && ctx.connected && ctx.idleMs < ctx.now - triggeredAt + 1000) {
          triggered = false;
        }

        for (const drop of drops) {
          const name = drop.name.toLowerCase();
          if (needles.some((n) => name.includes(n))) {
            triggered = true;
            triggeredAt = ctx.now;
            break;
          }
        }

        return { triggered, bar: triggered ? 1 : 0, functional: true };
      },
      reset() {
        triggered = false;
      },
    };
  },
});
