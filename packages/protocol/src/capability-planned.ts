import type { Capability } from "./capabilities.ts";

/** A feature that no test proves yet. */
export const planned = (
  id: string,
  phase: string,
  title: string,
  notes: string,
): Extract<Capability, { kind: "feature" }> => ({
  kind: "feature",
  id,
  title,
  status: "planned",
  phase,
  notes,
});

/** A feature a task delivered; `notes` names the test that proves it. */
export const implemented = (
  id: string,
  phase: string,
  title: string,
  notes: string,
): Extract<Capability, { kind: "feature" }> => ({
  ...planned(id, phase, title, notes),
  status: "implemented",
});
