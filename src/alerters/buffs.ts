import { z } from "zod";
import {
  clamp01,
  defineAlerter,
  type AlerterContext,
  type BuffSlot,
  type TriggerState,
} from "~/engine/types";

export const BuffTypeSchema = z.object({
  /** Known buff id, or "" when the user captured their own icon. */
  buffid: z.string().default(""),
  /** Base64 PNG of the captured icon. */
  imgstr: z.string().default(""),
  isdebuff: z.boolean().default(false),
  /** Present in AfkWarden configs; deliberately ignored -- templates never change here. */
  final: z.boolean().optional(),
  canimprove: z.boolean().optional(),
});

export const BuffVars = z.object({
  bufftype: BuffTypeSchema,
  /** Seconds remaining at which the progress bar starts filling. */
  starttime: z.number().int().positive().default(150),
  /** Seconds remaining at which the alert fires. */
  endtime: z.number().int().min(0).default(10),
});

export type BuffVars = z.infer<typeof BuffVars>;

/**
 * RuneScape abbreviates long buff timers, so a displayed value is a floor: "5"
 * minutes means somewhere in [5:00, 6:00). AfkWarden compensates by adding the
 * unit back, and this reproduces that so imported alerts fire at the same moment.
 */
export function compensateAbbreviation(seconds: number): number {
  if (seconds >= 3600) return seconds + 3600;
  if (seconds >= 60) return seconds + 60;
  return seconds;
}

/**
 * Watches the buff bar and fires as a buff runs out.
 *
 * Two departures from AfkWarden, both deliberate:
 *
 *  - Templates are never mutated. AfkWarden re-masks the stored icon on every
 *    successful match (`isolateBuffer`), a ratchet that only removes pixels, so
 *    templates decay toward its absolute 50-pixel match floor and then start
 *    failing intermittently forever. Real templates were measured at 53 pixels.
 *  - Matching scores as a fraction of the template's own opaque pixels, so a
 *    sparse template is judged on what it claims to know rather than on a count
 *    it can never reach.
 *
 * A buff that is absent counts as zero seconds remaining, which is what makes an
 * expired buff fire rather than fall silent.
 */
export const buffsAlerter = defineAlerter<BuffVars>({
  type: "buffs",
  typename: "Buffs",
  descr: "Triggers when a buff or debuff runs out, or is about to.",
  schema: BuffVars,
  fields: [
    { key: "bufftype", kind: "buffimage", label: "Buff to watch" },
    {
      key: "starttime",
      kind: "number",
      label: "Start bar at",
      min: 1,
      suffix: "sec",
      help: "How much time remaining counts as a full bar.",
    },
    { key: "endtime", kind: "number", label: "Alert at", min: 0, suffix: "sec remaining" },
  ],
  create(vars) {
    // Smooths the countdown between discrete timer reads: the on-screen number
    // only changes once a second at best, and less often for long timers.
    let lastReadValue = -1;
    let lastReadAt = 0;

    return {
      check(ctx: AlerterContext): TriggerState {
        // An alert imported from AfkWarden identifies its buff by a captured
        // icon, which Bolt cannot use: buffs are matched against the game's own
        // texture atlas and identified by name. Such an alert is not broken, it
        // is UNMIGRATED -- so it reports "cannot see" rather than a confident
        // "not triggered", and the editor offers a buff to pick. See P2.5.
        if (vars.bufftype.buffid.length === 0) {
          return { triggered: false, bar: 0, functional: false };
        }

        if (!ctx.connected) {
          return { triggered: false, bar: 0, functional: false };
        }

        const slots: readonly BuffSlot[] = vars.bufftype.isdebuff
          ? ctx.state.debuffs
          : ctx.state.buffs;

        let timeLeft = 0;
        const slot = slots.find((s) => s.id === vars.bufftype.buffid);
        if (slot !== undefined) {
          if (slot.timeLeft !== null) {
            const compensated = compensateAbbreviation(slot.timeLeft);
            if (compensated === lastReadValue) {
              timeLeft = Math.max(0, compensated - (ctx.now - lastReadAt) / 1000);
            } else {
              lastReadValue = compensated;
              lastReadAt = ctx.now;
              timeLeft = compensated;
            }
          }
        } else {
          lastReadValue = -1;
        }

        return {
          triggered: timeLeft <= vars.endtime,
          bar: clamp01(1 - timeLeft / vars.starttime),
          functional: true,
        };
      },
      reset() {
        lastReadValue = -1;
        lastReadAt = 0;
      },
    };
  },
});
