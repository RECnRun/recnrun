import type { Snapshot } from "@recnrun/domain";
import { render } from "preact";
import { Dashboard } from "@/dashboard/Dashboard";
import { createHashRouter } from "@/dashboard/router";

export function startDashboard(root: HTMLElement, loadSnapshot: () => Promise<Snapshot>): void {
  render(<Dashboard loadSnapshot={loadSnapshot} router={createHashRouter()} />, root);
}
