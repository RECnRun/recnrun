import { IdentitySchema } from "@recnrun/domain";
import type { CaptureCapabilities, Identity } from "@recnrun/domain";
import * as v from "valibot";
import { WorkspaceError } from "@/background/workspace/errors";

/** What the dashboard sends to create an identity; the background adds its id and time. */
export interface IdentityDraft {
  label: string;
  url: string;
  capabilities: CaptureCapabilities;
}

/** A host name of non-empty labels, as a cookie's domain and Chrome's host patterns name it. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const isHostName = (host: string) => host.split(".").every((label) => LABEL.test(label));

/** The draft as a saved identity created at `created`, or a refusal naming what it needs. */
export function validIdentity(draft: IdentityDraft, created: number): Identity {
  const parsed = v.safeParse(IdentitySchema, { id: crypto.randomUUID(), created, ...draft });
  if (!parsed.success) {
    const message = "Give the identity a label and an http or https address.";
    throw new WorkspaceError("IdentityNotValid", message);
  }
  // Chrome reports host names lowercased, so a declared host is compared in that form.
  const cookieHosts = [
    ...new Set(parsed.output.capabilities.cookieHosts.map((host) => host.toLowerCase())),
  ];
  if (!cookieHosts.every(isHostName)) {
    throw new WorkspaceError(
      "IdentityNotValid",
      "Cookie hosts are host names, such as sso.example.com.",
    );
  }
  return { ...parsed.output, capabilities: { cookieHosts } };
}
