import { render } from "preact";
import { cloneControlServices } from "@/onboarding/clone-control-page-services";
import { CloneControlPanel } from "@/onboarding/CloneControlPanel";
import "@/onboarding/prepare-workers.css";

/** Adds "Clones" beside the dashboard when this profile is the master; POC builds only. */
export async function mountCloneControl(page: Document = document): Promise<void> {
  const control = cloneControlServices();
  if (!(await control.isMaster())) return;
  const root = page.body.appendChild(page.createElement("div"));
  root.id = "clone-control";
  render(<CloneControlPanel control={control} />, root);
}
