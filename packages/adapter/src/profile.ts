import { dirname } from "node:path";
import type { BrowserHandshake, ConnectionSource, ProfileDescription } from "@recnrun/protocol";
import * as v from "valibot";
import type { CdpSession } from "./cdp-link.ts";
import { parseTargets } from "./handshake.ts";

// `defaultBrowserContextId` is experimental in CDP, so it may be absent.
const BrowserContextsSchema = v.object({
  browserContextIds: v.array(v.string()),
  defaultBrowserContextId: v.optional(v.string()),
});

function profileFolder(source: ConnectionSource | undefined): string {
  if (!source) {
    throw new Error(
      "This connection does not know its profile folder; connect with a userDataDir or activePortFile.",
    );
  }
  return "userDataDir" in source ? source.userDataDir : dirname(source.activePortFile);
}

/** Describes the profile behind a connection, so a binding can be created or refreshed from it. */
export async function describeProfile(
  session: CdpSession,
  handshake: BrowserHandshake,
  source: ConnectionSource | undefined,
): Promise<ProfileDescription> {
  const userDataDir = profileFolder(source);
  const contexts = v.parse(BrowserContextsSchema, await session.send("Target.getBrowserContexts"));
  const targets = parseTargets(await session.send("Target.getTargets"));
  // Pages also name their context, which covers a default context the reply leaves out.
  const observed = [
    contexts.defaultBrowserContextId,
    ...contexts.browserContextIds,
    ...targets.map(({ browserContextId }) => browserContextId),
  ];
  const browserContextIds = [...new Set(observed)].filter((id): id is string => Boolean(id));
  return { userDataDir, browserContextIds, chrome: handshake.version.product };
}
