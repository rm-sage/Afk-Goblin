import type { AlerterModule } from "~/engine/types";
import { inactiveAlerter } from "~/alerters/inactive";
import { chatAlerter } from "~/alerters/chat";
import { actionbarAlerter } from "~/alerters/actionbar";
import { buffsAlerter } from "~/alerters/buffs";
import { bigXpAlerter, xpCounterAlerter } from "~/alerters/xpcounter";
import { clockBasedAlerter } from "~/alerters/clockbased";
import { dialogAlerter, dropsAlerter, targetDeathAlerter } from "~/alerters/misc";

/**
 * Alerter modules that are implemented and wired up.
 *
 * `KNOWN_ALERTER_TYPES` lists all 16 types AfkWarden ships; this map lists the
 * subset AFK Goblin can currently run. The gap is deliberate and visible: importing a
 * preset that uses a not-yet-implemented type keeps the alerter and flags it,
 * rather than dropping it silently.
 */
const MODULES: ReadonlyArray<AlerterModule<never>> = [
  inactiveAlerter as unknown as AlerterModule<never>,
  chatAlerter as unknown as AlerterModule<never>,
  actionbarAlerter as unknown as AlerterModule<never>,
  buffsAlerter as unknown as AlerterModule<never>,
  xpCounterAlerter as unknown as AlerterModule<never>,
  bigXpAlerter as unknown as AlerterModule<never>,
  clockBasedAlerter as unknown as AlerterModule<never>,
  dialogAlerter as unknown as AlerterModule<never>,
  targetDeathAlerter as unknown as AlerterModule<never>,
  dropsAlerter as unknown as AlerterModule<never>,
];

const BY_TYPE = new Map<string, AlerterModule<never>>(MODULES.map((m) => [m.type, m]));

export function getAlerterModule(type: string): AlerterModule<never> | undefined {
  return BY_TYPE.get(type);
}

export function implementedTypes(): string[] {
  return [...BY_TYPE.keys()];
}

/** Modules the editor can offer, in registration order. */
export function implementedModules(): ReadonlyArray<AlerterModule<never>> {
  return MODULES;
}

export function isImplemented(type: string): boolean {
  return BY_TYPE.has(type);
}
