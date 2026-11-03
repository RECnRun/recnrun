import type { ButtonHTMLAttributes } from "preact";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
};

/** A button that never submits a form by accident; `primary` is the one call to action. */
export function Button({ variant = "secondary", type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} class={`button button-${variant}`} />;
}
