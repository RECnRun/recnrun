import { IdentitySchema } from "@recnrun/domain";
import type { Identity } from "@recnrun/domain";
import * as v from "valibot";
import { WorkspaceError } from "@/background/workspace/errors";

/** What the dashboard sends to create an identity; the background adds its id and time. */
export interface IdentityDraft {
  label: string;
  url: string;
}

/** The draft as a saved identity created at `created`, or a refusal naming what it needs. */
export function validIdentity(draft: IdentityDraft, created: number): Identity {
  const parsed = v.safeParse(IdentitySchema, { id: crypto.randomUUID(), created, ...draft });
  if (!parsed.success) {
    const message = "Give the identity a label and an http or https address.";
    throw new WorkspaceError("IdentityNotValid", message);
  }
  return parsed.output;
}
