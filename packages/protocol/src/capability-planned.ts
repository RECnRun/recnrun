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
