import { render } from "preact";
import { onboardingServices } from "@/onboarding/page-services";
import { PrepareWorkers } from "@/onboarding/PrepareWorkers";
import "@/onboarding/prepare-workers.css";

/** Adds "Prepare workers" beside the dashboard when this profile is the master; POC builds only. */
export async function mountPrepareWorkers(page: Document = document): Promise<void> {
  const onboarding = onboardingServices();
  if (!(await onboarding.isMaster())) return;
  const root = page.body.appendChild(page.createElement("div"));
  root.id = "prepare-workers";
  render(<PrepareWorkers onboarding={onboarding} />, root);
}
