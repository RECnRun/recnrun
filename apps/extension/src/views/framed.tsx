import type { ComponentChild } from "preact";
import { render } from "preact";
import { disallowedAncestor } from "@/config/origins";
import { Refusal, SiteOnly } from "@/views/Refusal";

/**
 * Renders an extension page only under the site that frames it: a foreign ancestor gets a
 * refusal, no ancestor a pointer to the site, and `framed` gets the site's origin to talk to.
 */
export function renderFramed(
  root: HTMLElement,
  page: Window,
  mode: string,
  framed: (parent: string) => ComponentChild,
): void {
  const ancestors = [...page.location.ancestorOrigins];
  // A page framing recnrun.com could clickjack the extension's pages, so any foreign ancestor stops them.
  const blocked = disallowedAncestor(ancestors, mode);
  if (blocked !== undefined) return render(<Refusal origin={blocked} />, root);
  const [parent] = ancestors;
  if (parent === undefined) return render(<SiteOnly />, root);
  render(framed(parent), root);
}
