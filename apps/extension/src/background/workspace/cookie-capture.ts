import type { SiteCookie } from "@recnrun/domain";
import type { CookieApi, StoredCookie } from "@/background/workspace/cookie-stores";
import { WorkspaceError } from "@/background/workspace/errors";

/** A host-only cookie belongs to its host; a domain cookie to every host within its domain. */
function belongs({ domain, hostOnly }: StoredCookie, hosts: readonly string[]): boolean {
  if (hostOnly) return hosts.includes(domain);
  const bare = domain.replace(/^\./, "");
  return hosts.some((host) => host === bare || host.endsWith(`.${bare}`));
}

/** Where a restore sets the cookie: its domain, its own host, or (left out) the target's host. */
function scope({ domain, hostOnly }: StoredCookie, target: string) {
  if (!hostOnly) return { domain };
  return domain === target ? {} : { host: domain };
}

/** The cookie as `cookies.set` takes it back; Chrome's other fields, such as `storeId`, stay out. */
function siteCookie(stored: StoredCookie, target: string): SiteCookie {
  const { name, value, path, secure, httpOnly, sameSite, expirationDate, partitionKey } = stored;
  return {
    name,
    value,
    ...scope(stored, target),
    path,
    secure,
    httpOnly,
    sameSite,
    ...(!stored.session && expirationDate !== undefined && { expirationDate }),
    ...(partitionKey && { partitionKey }),
  };
}

/**
 * The names the page showed beyond the cookies Chrome listed that it could read: non-HttpOnly ones
 * of its host or domain. Path and `Secure` are ignored, so a listed cookie the page could not see
 * still counts; that hides some losses but never reports a cookie that was listed.
 */
function unlisted(listed: readonly StoredCookie[], host: string, seen: readonly string[]) {
  const readable = listed.filter((cookie) => !cookie.httpOnly && belongs(cookie, [host]));
  const left = readable.map(({ name }) => name);
  const missing = new Set<string>();
  for (const name of seen) {
    const index = left.indexOf(name);
    if (index === -1) missing.add(name);
    else left.splice(index, 1);
  }
  return [...missing];
}

async function list(api: Pick<CookieApi, "all">, storeId: string): Promise<StoredCookie[]> {
  try {
    return await api.all(storeId);
  } catch {
    throw new WorkspaceError("CookiesNotCaptured", "Chrome did not list the workspace's cookies.");
  }
}

/**
 * Reads every cookie of `storeId`, the identity's whole Incognito store. `seen` holds the cookie names the page itself showed: one Chrome did
 * not list, as for a site the user withheld from RECnRun (`cookies_helpers.cc:51-56`), fails it.
 */
export async function captureCookies(
  api: Pick<CookieApi, "all">,
  storeId: string,
  target: string,
  seen: readonly string[],
): Promise<SiteCookie[]> {
  const listed = await list(api, storeId);
  const missing = unlisted(listed, target, seen);
  if (missing.length > 0) {
    const names = missing.map((name) => `"${name}"`).join(", ");
    throw new WorkspaceError(
      "CookiesNotReadable",
      `Chrome did not list the page's cookies ${names}; give RECnRun access to all sites in chrome://extensions.`,
    );
  }
  return listed.map((stored) => siteCookie(stored, target));
}
