import type { ComponentChildren } from "preact";

/** A label wrapping its control, so the control's accessible name is the label text. */
export function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
    </label>
  );
}
