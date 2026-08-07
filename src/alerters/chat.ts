import { z } from "zod";
import {
  defineAlerter,
  type AlerterContext,
  type ChatLine,
  type RGB,
  type TriggerState,
} from "~/engine/types";

const RGBSchema = z.tuple([z.number(), z.number(), z.number()]);

export const ChatVars = z.object({
  /** Any match fires the alert. `percent` is AfkWarden's confidence weight. */
  lines: z
    .array(z.object({ text: z.string(), percent: z.number().default(100) }))
    .default([]),
  /** Text colours to accept. Empty means accept any colour. */
  colors: z.array(RGBSchema).default([]),
  /** Clear the triggered state as soon as the player interacts with the game. */
  resetonactive: z.boolean().default(true),
});

export type ChatVars = z.infer<typeof ChatVars>;

function colorMatches(line: ChatLine, colors: readonly RGB[]): boolean {
  if (colors.length === 0) return true;

  // A line whose colour could not be read must not be EXCLUDED by a colour
  // filter. Bolt's chat module reads text but reports no colour, and 71 of the
  // 108 alerts in the reference config specify colours -- treating "unknown" as
  // "mismatch" would silently disable almost every chat alert.
  //
  // Fails open on purpose, consistent with the login gate: a wrong "no" silences
  // an alert, which is the failure this project exists to remove, while a wrong
  // "yes" costs a glance. The text match still has to succeed either way.
  if (line.colors.length === 0) return true;

  // Any colour present in the line counts: the relevant part of a message is
  // often not its first fragment.
  return colors.some((c) =>
    line.colors.some((l) => l[0] === c[0] && l[1] === c[1] && l[2] === c[2]),
  );
}

/**
 * Triggers when a monitored chatbox produces a line containing any configured text.
 *
 * Matching is a case-insensitive substring test, which is what AfkWarden does and
 * what existing presets are written against -- entries like
 * "has gained a level! It is now level 2" are deliberate fragments of a longer line.
 *
 * Colour filtering is an additional constraint, not the primary discriminator. In
 * real configs it discriminates very little: 20 of 33 chat alerters in one boss
 * preset share an identical 7-colour set, so text does effectively all the work.
 */
export const chatAlerter = defineAlerter<ChatVars>({
  type: "chat",
  typename: "Chatbox",
  descr: "Triggers when a chat message matching your text appears in any monitored chatbox.",
  schema: ChatVars,
  fields: [
    {
      key: "lines",
      kind: "lines",
      label: "Text that triggers this alert",
      help: "Matched as a case-insensitive substring, so a fragment of a longer message works.",
    },
    {
      key: "colors",
      kind: "colors",
      label: "Text colours to accept",
      help: "Leave empty to accept any colour.",
    },
    { key: "resetonactive", kind: "boolean", label: "Reset after clicking RuneScape" },
  ],
  create(vars) {
    const needles = vars.lines
      .map((l) => l.text.toLowerCase())
      .filter((t) => t.length > 0);

    let triggered = false;
    let triggeredAt = 0;

    return {
      check(ctx: AlerterContext): TriggerState {
        // An alerter with no needles can never fire. The importer promotes those to
        // group headers, so reaching here means it was configured but left empty.
        if (needles.length === 0) {
          return { triggered: false, bar: 0, functional: false };
        }

        // No chatbox located means this alert is blind, not quiet. Saying so is
        // the difference between "nothing happened" and "I would never have told
        // you if it had".
        if (!ctx.chatAvailable) {
          return { triggered, bar: triggered ? 1 : 0, functional: false };
        }

        if (triggered && vars.resetonactive && ctx.connected) {
          // Both sides are "milliseconds since": idleMs since the last click, and
          // (now - triggeredAt) since this alert fired. The smaller value is the
          // more recent event, so a click that postdates the alert clears it.
          // The 1s slack matches AfkWarden and absorbs tick granularity.
          if (ctx.idleMs < ctx.now - triggeredAt + 1000) triggered = false;
        }

        for (const line of ctx.chatLines) {
          if (!colorMatches(line, vars.colors)) continue;
          const hay = line.text.toLowerCase();
          if (needles.some((n) => hay.includes(n))) {
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
