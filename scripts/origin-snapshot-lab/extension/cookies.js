// Experiment D: the cookies of related hosts (a sign-in server on another host) travel with the
// origin's snapshot. Only the background touches them; the page scripts never see their values.

/** Unpartitioned cookies whose domain is `host` or one of its subdomains. */
async function cookiesOf(hosts) {
  const lists = await Promise.all(hosts.map((domain) => chrome.cookies.getAll({ domain })));
  return lists.flat();
}

const urlOf = (cookie) =>
  `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;

export const captureCookies = (hosts) => cookiesOf(hosts);

/** Removes the hosts' cookies, then sets `target`'s; expired ones are skipped and counted. */
export async function replaceCookies(hosts, target) {
  const current = await cookiesOf(hosts);
  for (const cookie of current) {
    const removed = await chrome.cookies.remove({
      url: urlOf(cookie),
      name: cookie.name,
      storeId: cookie.storeId,
    });
    if (!removed) throw new Error(`could not remove cookie ${cookie.name} on ${cookie.domain}`);
  }
  const now = Date.now() / 1000;
  const live = target.filter((cookie) => cookie.session || cookie.expirationDate > now);
  for (const cookie of live) {
    await chrome.cookies.set({
      url: urlOf(cookie),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      storeId: cookie.storeId,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }),
    });
  }
  return { removed: current.length, set: live.length, expired: target.length - live.length };
}
