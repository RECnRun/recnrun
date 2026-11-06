import { requireHost } from "./fixtures/host-env.ts";

/** Refuses the whole run, before any Chrome starts, off the Mac or with RECNRUN_HOST_ROOTS invalid. */
export default function globalSetup(): void {
  const roots = requireHost();
  console.log(`Host roots: ${roots}/roots/${process.env.RECNRUN_RUN_ID ?? ""}/`);
}
