import type { ComponentChildren } from "preact";

export function CommandStep({
  command,
  children,
}: {
  command: string;
  children: ComponentChildren;
}) {
  return (
    <li class="command-step">
      <p>{children}</p>
      <pre>
        <code>{command}</code>
      </pre>
    </li>
  );
}
