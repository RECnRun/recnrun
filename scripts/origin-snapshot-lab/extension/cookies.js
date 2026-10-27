// Experiment D: the cookies of related hosts (a sign-in server on another host) travel with the
// origin's snapshot. Only the background touches them; the page scripts never see their values.
// Every call names the tab's cookie store: an incognito tab's is not the background's default.

/** The id of the cookie store `tabId` uses. */
export async function storeOf(tabId) {
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find((each) => each.tabIds.includes(tabId));
  if (!store) throw new Error(`no cookie store holds tab ${tabId}`);
  return store.id;
}

/** Unpartitioned cookies whose domain is `host` or one of its subdomains. */
async function cookiesOf(hosts, storeId) {
  const lists = await Promise.all(
    hosts.map((domain) => chrome.cookies.getAll({ domain, storeId })),
  );
  return lists.flat();
}

const urlOf = (cookie) =>
  `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;

export const captureCookies = (hosts, storeId) => cookiesOf(hosts, storeId);

/** Removes the hosts' cookies, then sets `target`'s; expired ones are skipped and counted. */
export async function replaceCookies(hosts, target, storeId) {
  const current = await cookiesOf(hosts, storeId);
  for (const cookie of current) {
    const removed = await chrome.cookies.remove({
      url: urlOf(cookie),
      name: cookie.name,
      storeId,
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
      storeId,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
      ...(cookie.session ? {} : { expirationDate: cookie.expirationDate }),
    });
  }
  return { removed: current.length, set: live.length, expired: target.length - live.length };
}
