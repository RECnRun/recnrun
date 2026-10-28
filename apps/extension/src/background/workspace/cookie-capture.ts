import type { IdentityCapture, SiteCookie } from "@recnrun/domain";
import type { CookieApi, StoredCookie } from "@/background/workspace/cookie-stores";

type Unsupported = IdentityCapture["unsupported"][number];

/** The hosts whose cookies a capture keeps: the target's, and those its capabilities declare. */
export interface CookieHosts {
  target: string;
  extra: readonly string[];
}

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

/** Reads `storeId`'s cookies and keeps those of the given hosts; it names the others, never their values. */
export async function captureCookies(
  api: Pick<CookieApi, "all">,
  storeId: string,
  hosts: CookieHosts,
): Promise<{ cookies: SiteCookie[]; unsupported: Unsupported[] }> {
  const kept = [hosts.target, ...hosts.extra];
  const cookies: SiteCookie[] = [];
  const unsupported: Unsupported[] = [];
  for (const stored of await api.all(storeId)) {
    if (belongs(stored, kept)) cookies.push(siteCookie(stored, hosts.target));
    else {
      unsupported.push({
        adapter: "cookies",
        item: `${stored.name} on ${stored.domain}${stored.path}`,
        reason: "Its host is neither the target's nor a declared cookie host.",
      });
    }
  }
  return { cookies, unsupported };
}
