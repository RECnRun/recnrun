import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";

type CardProps = { title: string; actions?: ComponentChildren; children: ComponentChildren };

/** A titled region; its heading names it for assistive technology and tests. */
export function Card({ title, actions, children }: CardProps) {
  const id = useId();
  return (
    <section class="card" aria-labelledby={id}>
      <header class="card-header">
        <h2 id={id}>{title}</h2>
        {actions ? <div class="actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
