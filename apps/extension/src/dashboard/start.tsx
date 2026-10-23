import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import { disallowedAncestor } from "@/config/origins";
import { Dashboard, Refusal } from "@/dashboard/Dashboard";
import { createFrameRouter, createHashRouter } from "@/dashboard/router";

export function startDashboard(
  root: HTMLElement,
  loadSnapshot: () => Promise<Snapshot>,
  page: Window = window,
): void {
  const ancestors = [...page.location.ancestorOrigins];
  // A page framing recnrun.com could clickjack the dashboard, so any foreign ancestor stops it.
  const blocked = disallowedAncestor(ancestors, import.meta.env.MODE);
  if (blocked !== undefined) {
    render(<Refusal origin={blocked} />, root);
    return;
  }
  const parent = ancestors[0];
  const router = parent === undefined ? createHashRouter(page) : createFrameRouter(parent, page);
  render(<Dashboard loadSnapshot={loadSnapshot} router={router} />, root);
}
