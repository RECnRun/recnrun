import { browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { cookieHostPatterns } from "@/config/permissions";

/** Whether the build holds host access to every pattern in `origins`. */
export interface HostPermissions {
  contains: (origins: string[]) => Promise<boolean>;
}

export const chromeHostPermissions: HostPermissions = {
  contains: (origins) => browser.permissions.contains({ origins }),
};

/**
 * Refuses hosts whose cookies the build could not list or set: `cookies.getAll` leaves such a
 * cookie out without an error, so a capture would lose it silently.
 */
export async function requireCookieHosts(
  hosts: readonly string[],
  permissions: HostPermissions = chromeHostPermissions,
): Promise<void> {
  const reached = await Promise.all(
    hosts.map((host) => permissions.contains(cookieHostPatterns(host))),
  );
  const missing = hosts.filter((_, index) => reached[index] !== true);
  if (missing.length > 0) {
    const message = `This build cannot read the cookies of ${missing.join(", ")}; build it with RECNRUN_POC_HOSTS naming them.`;
    throw new WorkspaceError("CookieHostNotAllowed", message);
  }
}
