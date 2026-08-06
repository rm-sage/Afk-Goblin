import { z } from "zod";
import { clamp01, defineAlerter, type AlerterContext, type TriggerState } from "~/engine/types";
import { SKILL_OPTIONS } from "~/engine/fields";

/**
 * AfkWarden is inconsistent about the "total" skill code: its dropdown stores
 * `tot` while its own premade presets ship `total`. Both appear in real configs,
 * so both are accepted and tried against the reader.
 */
export function skillAliases(skill: string): string[] {
  if (skill === "tot" || skill === "total") return ["tot", "total"];
  return [skill];
}

function readXp(ctx: AlerterContext, skill: string): number | null {
  for (const alias of skillAliases(skill)) {
    const xp = ctx.state.xp[alias] ?? null;
    if (xp !== null) return xp;
  }
  return null;
}

export const XpCounterVars = z.object({
  /** Seconds without a qualifying XP gain before triggering. */
  delay: z.number().int().positive().default(5),
  /** Minimum XP gain that counts as activity. */
  threshold: z.number().int().min(0).default(0),
  skill: z.string().default("tot"),
});

export type XpCounterVars = z.infer<typeof XpCounterVars>;

/**
 * Triggers when a skill stops gaining XP.
 *
 * The canonical use is skills with rapid, predictable drops — the XP stopping is
 * a faster signal that something went wrong than waiting for the lobby timer.
 */
export const xpCounterAlerter = defineAlerter<XpCounterVars>({
  type: "xpcounter",
  typename: "XP counter inactivity",
  descr: "Triggers when you have not gained XP in a skill for a set time.",
  schema: XpCounterVars,
  fields: [
    { key: "skill", kind: "select", label: "Skill", options: SKILL_OPTIONS },
    { key: "delay", kind: "number", label: "Alert after", min: 1, suffix: "sec without XP" },
    {
      key: "threshold",
      kind: "number",
      label: "Minimum XP drop",
      min: 0,
      help: "Gains smaller than this do not count as activity.",
    },
  ],
  create(vars) {
    let lastXp = 0;
    let lastChangeAt = 0;
    let seeded = false;

    return {
      check(ctx: AlerterContext): TriggerState {
        const xp = readXp(ctx, vars.skill);
        if (xp === null) {
          return { triggered: false, bar: 0, functional: false };
        }

        // Without seeding, the first reading looks like a gain from zero and
        // resets the timer -- harmless, but it also means a fresh alert would
        // never fire until the first real drop.
        if (!seeded) {
          seeded = true;
          lastXp = xp;
          lastChangeAt = ctx.now;
        } else if (xp > lastXp + vars.threshold) {
          lastChangeAt = ctx.now;
        }
        lastXp = xp;

        const bar = clamp01((ctx.now - lastChangeAt) / (vars.delay * 1000));
        return { triggered: bar >= 1, bar, functional: true };
      },
      reset() {
        seeded = false;
        lastXp = 0;
        lastChangeAt = 0;
      },
    };
  },
});

export const BigXpVars = z.object({
  /** Minimum single gain that counts as a "big" drop. */
  threshold: z.number().int().min(0).default(1000),
  skill: z.string().default("tot"),
});

export type BigXpVars = z.infer<typeof BigXpVars>;

/**
 * Triggers after a large one-off XP gain — cleansing crystals, construction
 * contracts, safe cracking and similar.
 *
 * Stays triggered only until you click: the alert exists to tell you something
 * finished, so acting on it is what clears it.
 */
export const bigXpAlerter = defineAlerter<BigXpVars>({
  type: "bigxp",
  typename: "Big XP drops",
  descr: "Triggers after gaining a large XP drop in one go.",
  schema: BigXpVars,
  fields: [
    { key: "skill", kind: "select", label: "Skill", options: SKILL_OPTIONS },
    { key: "threshold", kind: "number", label: "Minimum XP drop", min: 0 },
  ],
  create(vars) {
    let lastXp = 0;
    let seeded = false;
    let dropAt = -1;

    return {
      check(ctx: AlerterContext): TriggerState {
        const xp = readXp(ctx, vars.skill);
        if (xp === null) {
          return { triggered: false, bar: 0, functional: false };
        }

        if (!seeded) {
          seeded = true;
          lastXp = xp;
        } else if (xp > lastXp + vars.threshold) {
          dropAt = ctx.now;
        }
        lastXp = xp;

        // idleMs is "ms since last click", so this is the click's timestamp.
        const lastClickAt = ctx.now - ctx.idleMs;
        const triggered = dropAt >= 0 && dropAt > lastClickAt;
        return { triggered, bar: triggered ? 1 : 0, functional: true };
      },
      reset() {
        seeded = false;
        lastXp = 0;
        dropAt = -1;
      },
    };
  },
});
