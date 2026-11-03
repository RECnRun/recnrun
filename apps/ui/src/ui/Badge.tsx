import type { ComponentChildren } from "preact";

export type Tone = "neutral" | "success" | "danger";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ComponentChildren;
}) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}
