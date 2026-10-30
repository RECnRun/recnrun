// The swap mode of the session manager: no debugger. The profile's own cookie store holds the
// active identity's cookies; a switch saves them (HttpOnly included) into the identity's jar with
// chrome.cookies and removes them, then writes the next identity's jar back. The page prelude
// learns the active identity from a cookie the extension sets on the app's domains, so storage
// keeps its namespace per identity; workers and pending requests are out of scope here.
import { jarOf, replaceJar } from "./jar-store.js";

/** The domains the identity cookie is set on: the lab's hosts, or a real site's (`setDomains`). */
let domains = ["app.localhost", "idp.localhost"];
/** The cookie that tells the prelude which identity is active. */
const IDENTITY_COOKIE = "__rnr";
/** The jar that keeps what the profile held before the first switch. */
export const PROFILE_JAR = "profile";

const SAME_SITE_TO_JAR = { no_restriction: "none", lax: "lax", strict: "strict" };
const SAME_SITE_TO_CHROME = { none: "no_restriction", lax: "lax", strict: "strict" };

const urlOf = (cookie) =>
  `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;

/** A chrome.cookies cookie as the jar stores it. */
function toJar(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.replace(/^\./, ""),
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: SAME_SITE_TO_JAR[cookie.sameSite],
    expires: cookie.expirationDate === undefined ? undefined : cookie.expirationDate * 1000,
    partitionKey: cookie.partitionKey,
  };
}

/** A jar cookie as chrome.cookies.set takes it. */
function toChrome(cookie) {
  return {
    url: urlOf(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === undefined ? undefined : SAME_SITE_TO_CHROME[cookie.sameSite],
    expirationDate: cookie.expires === undefined ? undefined : cookie.expires / 1000,
    partitionKey: cookie.partitionKey,
  };
}

/** Every cookie of the profile, partitioned ones included: the profile is disposable and is the tab's. */
const allCookies = () => chrome.cookies.getAll({ partitionKey: {} });

/** The domains a real site's pages run on, so the prelude finds the identity cookie there. */
export const setDomains = (list) => (domains = list);

/** Saves the store's cookies as `container`'s jar (the identity cookie excluded). */
export async function save(container) {
  const jar = (await allCookies()).filter(({ name }) => name !== IDENTITY_COOKIE).map(toJar);
  await replaceJar(container, jar);
  return jar.length;
}

/** Removes the store's cookies, at most `limit` of them; returns how many were removed. */
export async function empty(limit = Infinity) {
  const cookies = (await allCookies()).slice(0, limit);
  for (const cookie of cookies) {
    const { name, partitionKey } = cookie;
    await chrome.cookies.remove({ url: urlOf(cookie), name, partitionKey });
  }
  return cookies.length;
}

/** Writes `container`'s jar into the store and marks the identity for the prelude. */
export async function restore(container) {
  const jar = await jarOf(container);
  for (const cookie of jar) await chrome.cookies.set(toChrome(cookie));
  for (const domain of domains) {
    const scheme = domain.endsWith("localhost") ? "http" : "https";
    await chrome.cookies.set({
      url: `${scheme}://${domain}/`,
      domain: domain.endsWith("localhost") ? undefined : domain,
      name: IDENTITY_COOKIE,
      value: container,
      path: "/",
      secure: scheme === "https",
    });
  }
  return jar.length;
}
