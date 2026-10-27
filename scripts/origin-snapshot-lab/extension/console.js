// Experiment G: the lab in the person's own Chrome. preset.json, which unpacked.mjs writes into
// the copy it loads, configures the lab whenever the worker starts, and `rec` gives the worker's
// console short commands. The specs' copy has no preset.
import { replaceCookies, storeOf } from "./cookies.js";
import { manage, managed, partitionOf } from "./group.js";
import { getCapture } from "./repo.js";
import { options, switchTo } from "./switch.js";

const PRESET = { firstIdentity: "A", clear: { timeoutMs: 5000, probe: true }, timeoutMs: 30000 };

const tabsOf = async (origin, incognito) =>
  (await chrome.tabs.query({})).filter(
    (tab) => tab.incognito === incognito && URL.parse(tab.url ?? "")?.origin === origin,
  );

/** The group's tab on the origin that leads a switch: the active one if it can. */
export async function leadFor(origin, incognito) {
  const grouped = (await tabsOf(origin, incognito)).filter((tab) => managed.has(tab.groupId));
  const lead = grouped.find((tab) => tab.active) ?? grouped[0];
  if (!lead) throw new Error(`no tab of ${origin} in the RECnRun group`);
  return lead.id;
}

/** The receipt of a switch without any stored value. */
const receipt = ({ from, to, kind, tabs, ms, report }) => ({
  from,
  to,
  kind,
  tabs,
  ms: Math.round(ms),
  cleared: report.cleared?.deleted,
  cookies: report.cookies,
});

function commands(origin) {
  const run = async (to, incognito, reset) =>
    receipt(await switchTo(await leadFor(origin, incognito), to, { reset }));
  return {
    /** Puts the site's active tab, or its first, in a new RECnRun group as the first identity. */
    start: async (incognito = false) => {
      const tabs = await tabsOf(origin, incognito);
      const tab = tabs.find((each) => each.active) ?? tabs[0];
      if (!tab) throw new Error(`open ${origin} first`);
      if (managed.has(tab.groupId)) throw new Error("the tab is already in a RECnRun group");
      await manage(tab.id, options.firstIdentity);
      return `RECnRun · ${options.firstIdentity}`;
    },
    switch: (to, incognito = false) => run(to, incognito, false),
    reset: (to, incognito = false) => run(to, incognito, true),
    /** Puts `identity`'s captured cookie-host cookies back, after a switch left them wrong. */
    restoreCookies: async (identity, incognito = false) => {
      // Any tab of the partition names its cookie store: the site's may be on its sign-in host.
      const tab = (await chrome.tabs.query({})).find((each) => each.incognito === incognito);
      if (!tab) throw new Error("open a window first");
      const capture = await getCapture(origin, identity, partitionOf(tab));
      if (!capture) throw new Error(`no capture of ${identity}`);
      return replaceCookies(options.cookieHosts, capture.state.cookies, await storeOf(tab.id));
    },
  };
}

/** The site the preset names, and its commands; both stay empty in a copy without a preset. */
/** @type {{ origin: string | null, rec: ReturnType<typeof commands> | null }} */
export const site = { origin: null, rec: null };

/** Settings the dashboard changed outlive the worker: they apply over the preset at each start. */
export async function saveSettings({ forceClear }) {
  const settings = { forceClear: forceClear === true };
  await chrome.storage.local.set({ settings });
  Object.assign(options, settings);
  return settings;
}

/** Applies preset.json when the copy has one, and publishes `rec`. */
export async function applyPreset(register) {
  const response = await fetch(chrome.runtime.getURL("preset.json")).catch(() => undefined);
  if (!response?.ok) return;
  const { url, cookieHosts, forceClear } = await response.json();
  const { origin } = new URL(url);
  Object.assign(options, PRESET, {
    cookieHosts,
    forceClear: forceClear === true,
  });
  const { settings } = await chrome.storage.local.get("settings");
  Object.assign(options, settings);
  await register(origin);
  site.origin = origin;
  site.rec = commands(origin);
  globalThis.rec = site.rec;
}
