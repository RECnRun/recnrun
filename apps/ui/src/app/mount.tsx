import { render } from "preact";
import { App } from "@/app/App";

/** Renders the UI into the page's root element, if the page has one. */
export function mount(root: HTMLElement | null) {
  if (root) render(<App />, root);
}
