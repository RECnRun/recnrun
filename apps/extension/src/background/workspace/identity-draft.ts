import { IdentitySchema } from "@recnrun/domain";
import type { Identity } from "@recnrun/domain";
import * as v from "valibot";
import { WorkspaceError } from "@/background/workspace/errors";

/** What the dashboard sends to create an identity; the background adds its id and time. */
export interface IdentityDraft {
  /** Left out, the background names it with the next free letter. */
  label?: string;
  url: string;
}

/** The draft as a saved identity created at `created`, or a refusal naming what it needs. */
export function validIdentity(draft: Required<IdentityDraft>, created: number): Identity {
  const parsed = v.safeParse(IdentitySchema, { id: crypto.randomUUID(), created, ...draft });
  if (!parsed.success) {
    const url = parsed.issues.some(({ path }) => path?.[0]?.key === "url");
    const message = url
      ? "Only http and https pages can open in the Incognito workspace."
      : "Give the identity a label of 1 to 80 characters.";
    throw new WorkspaceError("IdentityNotValid", message);
  }
  return parsed.output;
}
