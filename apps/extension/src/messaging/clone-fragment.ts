import * as v from "valibot";
import { PocProvisionCloneSchema } from "@/messaging/poc-presence";
import type { CloneRequest } from "@/messaging/poc-presence";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// A role, or any key but these, never reaches the worker; NamespaceSchema checks the namespace.
const CLONE_FRAGMENT = new RegExp(
  `^#clone=(${UUID})&instance=(${UUID})&operation=(${UUID})&namespace=([^&]*)&master=(${UUID})\\.([\\w-]{87})$`,
);

export const CLONE_PREFIX = "#clone=";

/** The fields of a `#clone=` fragment in their one order, checked again as the message. */
export function cloneRequestOf(hash: string): CloneRequest | undefined {
  const [token, instanceId, operationId, namespace, masterProfileId, masterIdentity] =
    CLONE_FRAGMENT.exec(hash)?.slice(1) ?? [];
  const fields = { token, instanceId, operationId, namespace, masterProfileId, masterIdentity };
  const parsed = v.safeParse(PocProvisionCloneSchema, { type: "POC_PROVISION_CLONE", ...fields });
  if (!parsed.success) return undefined;
  const { type: _type, ...request } = parsed.output;
  return request;
}

/** The request a page's address names, when the address is the launcher's clone bootstrap page. */
export function cloneRequestOfPage(
  url: string | undefined,
  extensionUrl: string,
): CloneRequest | undefined {
  try {
    const page = new URL(url ?? "");
    const own = new URL(extensionUrl);
    if (page.origin !== own.origin || page.pathname !== "/bootstrap.html" || page.search)
      return undefined;
    return cloneRequestOf(page.hash);
  } catch {
    return undefined;
  }
}
