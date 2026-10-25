// A container's cookie jar: RFC 6265bis storage and matching, enough for the lab. Sites use the
// last two host labels, not the Public Suffix List.

/** The schemeful site of a URL: scheme and registrable domain, without the port. */
export function siteOf(url) {
  const { protocol, hostname } = new URL(url);
  return `${protocol}//${hostname.split(".").slice(-2).join(".")}`;
}

const isLocalhost = (host) => host === "localhost" || host.endsWith(".localhost");

/** Chrome treats localhost as a secure origin, so Secure cookies work there over http. */
function isSecureUrl({ protocol, hostname }) {
  return protocol === "https:" || isLocalhost(hostname);
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function defaultPath(pathname) {
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

function readAttributes(parts) {
  const attributes = {};
  for (const part of parts) {
    const [key = "", ...rest] = part.split("=");
    attributes[key.trim().toLowerCase()] = rest.join("=").trim();
  }
  return attributes;
}

function expiryOf(attributes, now) {
  if ("max-age" in attributes) return now + Number(attributes["max-age"]) * 1000;
  if ("expires" in attributes) return Date.parse(attributes.expires);
  return undefined;
}

function sameSiteOf(value = "") {
  const lower = value.toLowerCase();
  return lower === "none" || lower === "strict" ? lower : "lax";
}

function cookieDomain(attributes, host) {
  const domain = (attributes.domain ?? "").replace(/^\./, "").toLowerCase();
  if (!domain) return { domain: host, hostOnly: true };
  return domainMatches(host, domain) ? { domain, hostOnly: false } : undefined;
}

function prefixAllows(cookie) {
  if (cookie.name.startsWith("__Secure-")) return cookie.secure;
  if (!cookie.name.startsWith("__Host-")) return true;
  return cookie.secure && cookie.hostOnly && cookie.path === "/";
}

function buildCookie(nameValue, attributes, url, context) {
  const separator = nameValue.indexOf("=");
  const scope = cookieDomain(attributes, url.hostname);
  if (separator < 1 || !scope) return undefined;
  const path = attributes.path?.startsWith("/") ? attributes.path : defaultPath(url.pathname);
  return {
    name: nameValue.slice(0, separator).trim(),
    value: nameValue.slice(separator + 1).trim(),
    ...scope,
    path,
    secure: "secure" in attributes,
    httpOnly: "httponly" in attributes,
    sameSite: sameSiteOf(attributes.samesite),
    expires: expiryOf(attributes, context.now),
    partitionKey: "partitioned" in attributes ? context.topSite : undefined,
  };
}

/**
 * One cookie from a `Set-Cookie` header (or a `document.cookie` write with `fromScript`), as the
 * response to `requestUrl` would store it; `undefined` when a browser would reject it.
 */
export function parseSetCookie(header, requestUrl, now, { topSite, fromScript = false } = {}) {
  const url = new URL(requestUrl);
  const [nameValue = "", ...parts] = header.split(";");
  const attributes = readAttributes(parts);
  const cookie = buildCookie(nameValue, attributes, url, { now, topSite });
  if (!cookie || !prefixAllows(cookie)) return undefined;
  if (cookie.secure && !isSecureUrl(url)) return undefined;
  if (fromScript && cookie.httpOnly) return undefined;
  return { ...cookie, fromScript };
}

const sameKey = (a, b) =>
  a.name === b.name &&
  a.domain === b.domain &&
  a.path === b.path &&
  a.partitionKey === b.partitionKey;

/** The jar after storing `cookie`: it replaces the same key, and an expired one deletes it. */
export function storeCookie(jar, cookie, now) {
  if (!cookie) return jar;
  const existing = jar.find((stored) => sameKey(stored, cookie));
  if (existing?.httpOnly && cookie.fromScript) return jar;
  const rest = jar.filter((stored) => !sameKey(stored, cookie));
  const { fromScript: _, ...kept } = cookie;
  return cookie.expires !== undefined && cookie.expires <= now ? rest : [...rest, kept];
}

function sameSiteAllows(cookie, { crossSite = false, topLevelNavigation = false, method = "GET" }) {
  if (!crossSite || cookie.sameSite === "none") return true;
  if (cookie.sameSite === "strict") return false;
  return topLevelNavigation && ["GET", "HEAD"].includes(method);
}

function applies(cookie, url, options) {
  if (cookie.expires !== undefined && cookie.expires <= options.now) return false;
  const hostOk = cookie.hostOnly
    ? url.hostname === cookie.domain
    : domainMatches(url.hostname, cookie.domain);
  if (!hostOk || !pathMatches(url.pathname, cookie.path)) return false;
  if (cookie.secure && !isSecureUrl(url)) return false;
  if (cookie.partitionKey && cookie.partitionKey !== options.topSite) return false;
  return sameSiteAllows(cookie, options);
}

/** The `Cookie` header value the jar sends to `requestUrl`: longest paths first, as browsers do. */
export function cookieHeader(jar, requestUrl, options) {
  const url = new URL(requestUrl);
  return jar
    .filter((cookie) => applies(cookie, url, options))
    .toSorted((a, b) => b.path.length - a.path.length)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}
