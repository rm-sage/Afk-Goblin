import type { FieldSpec } from "~/engine/fields";

export type FieldEditorProps = {
  spec: FieldSpec;
  value: unknown;
  onChange(next: unknown): void;
  /** Opens the in-game capture picker for fields that support one. */
  onCapture?: () => void;
};

type RGB = [number, number, number];

function toHex(c: RGB): string {
  return `#${c.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(hex: string): RGB {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function asLines(value: unknown): Array<{ text: string; percent: number }> {
  return Array.isArray(value) ? (value as Array<{ text: string; percent: number }>) : [];
}

function asColors(value: unknown): RGB[] {
  return Array.isArray(value) ? (value as RGB[]) : [];
}

/** Renders one editable setting from its declared spec. */
export function FieldEditor({ spec, value, onChange, onCapture }: FieldEditorProps) {
  const help = spec.help !== undefined ? <p class="fld__help">{spec.help}</p> : null;

  if (spec.kind === "boolean") {
    return (
      <div class="fld fld--check">
        <label>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
          />
          {spec.label}
        </label>
        {help}
      </div>
    );
  }

  if (spec.kind === "number") {
    return (
      <div class="fld">
        <label class="fld__label">{spec.label}</label>
        <div class="fld__row">
          <input
            type="number"
            value={typeof value === "number" ? value : 0}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 1}
            onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
          />
          {spec.suffix !== undefined ? <span class="fld__suffix">{spec.suffix}</span> : null}
        </div>
        {help}
      </div>
    );
  }

  if (spec.kind === "text") {
    return (
      <div class="fld">
        <label class="fld__label">{spec.label}</label>
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          placeholder={spec.placeholder}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
        {help}
      </div>
    );
  }

  if (spec.kind === "select") {
    return (
      <div class="fld">
        <label class="fld__label">{spec.label}</label>
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        >
          {spec.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {help}
      </div>
    );
  }

  if (spec.kind === "lines") {
    const lines = asLines(value);
    return (
      <div class="fld">
        <label class="fld__label">{spec.label}</label>
        <textarea
          rows={Math.min(8, Math.max(3, lines.length + 1))}
          value={lines.map((l) => l.text).join("\n")}
          placeholder="One phrase per line"
          onInput={(e) => {
            const text = (e.target as HTMLTextAreaElement).value;
            onChange(
              text
                .split("\n")
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
                .map((t) => ({ text: t, percent: 100 })),
            );
          }}
        />
        {onCapture !== undefined ? (
          <button class="btn btn--ghost btn--sm" onClick={onCapture}>
            Pick from chat
          </button>
        ) : null}
        {help}
      </div>
    );
  }

  if (spec.kind === "colors") {
    const colors = asColors(value);
    return (
      <div class="fld">
        <label class="fld__label">{spec.label}</label>
        <div class="swatches">
          {colors.map((c, i) => (
            <span class="swatch" key={i}>
              <input
                type="color"
                value={toHex(c)}
                onInput={(e) => {
                  const next = colors.slice();
                  next[i] = fromHex((e.target as HTMLInputElement).value);
                  onChange(next);
                }}
              />
              <button
                class="iconbtn"
                title="Remove colour"
                onClick={() => onChange(colors.filter((_, n) => n !== i))}
              >
                ×
              </button>
            </span>
          ))}
          <button class="btn btn--ghost btn--sm" onClick={() => onChange([...colors, [255, 255, 255]])}>
            + colour
          </button>
        </div>
        {help}
      </div>
    );
  }

  // buffimage: a buff is chosen from the ones currently active, not typed and no
  // longer captured as pixels. An alert imported from AfkWarden still carries its
  // old icon and no id, which is UNMIGRATED rather than broken -- say so, and
  // point at the fix.
  const buff = (value ?? {}) as { buffid?: string; imgstr?: string; isdebuff?: boolean };
  const chosen = typeof buff.buffid === "string" && buff.buffid.length > 0;
  const legacy = !chosen && typeof buff.imgstr === "string" && buff.imgstr.length > 0;

  return (
    <div class="fld">
      <label class="fld__label">{spec.label}</label>
      <div class="fld__row">
        {chosen ? (
          <span class="fld__suffix">
            Watching <code>{buff.buffid}</code>
          </span>
        ) : legacy ? (
          <span class="badge badge--err" title="Imported from AfkWarden; needs re-picking once.">
            needs re-picking
          </span>
        ) : (
          <span class="fld__suffix">No buff chosen</span>
        )}
        <label class="fld__inline">
          <input
            type="checkbox"
            checked={buff.isdebuff === true}
            onChange={(e) =>
              onChange({ ...buff, isdebuff: (e.target as HTMLInputElement).checked })
            }
          />
          Debuff bar
        </label>
        {onCapture !== undefined ? (
          <button class="btn btn--ghost btn--sm" onClick={onCapture}>
            {chosen ? "Change buff" : "Choose buff"}
          </button>
        ) : null}
      </div>
      {legacy ? (
        <p class="fld__help">
          This alert was imported with a captured icon. Bolt identifies buffs differently, so
          apply the buff in game and press <strong>Choose buff</strong> once to relink it.
        </p>
      ) : null}
      {help}
    </div>
  );
}
