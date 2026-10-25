// Writes cookies a control tab received before it was classified into Chrome's own jar, as Chrome
// would have stored them.
import { parseSetCookie } from "./jar.js";

const SAME_SITE = { none: "no_restriction", lax: "lax", strict: "strict" };

export async function setRealCookies(headers, requestUrl) {
  const { protocol } = new URL(requestUrl);
  for (const header of headers) {
    const cookie = parseSetCookie(header, requestUrl, Date.now());
    if (!cookie) continue;
    await chrome.cookies.set({
      url: `${protocol}//${cookie.domain}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      domain: cookie.hostOnly ? undefined : cookie.domain,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: SAME_SITE[cookie.sameSite],
      expirationDate: cookie.expires === undefined ? undefined : cookie.expires / 1000,
    });
  }
}
