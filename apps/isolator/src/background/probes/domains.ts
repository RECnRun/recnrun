import { attempt, findTarget, send, tabDebuggee, unavailable } from "@/background/probes/helpers";
import type { CommandResult } from "@/background/probes/helpers";
import type {
  Debuggee,
  ProbeContext,
  ProbeDefinition,
  ProbeTargets,
} from "@/background/probes/types";

const PROBE_COOKIE = "recnrun_probe";

/** Fetch patterns for the fixture's worker scripts, from the URLs the harness passed. */
export function workerScriptPatterns(urls: ProbeTargets): { urlPattern: string }[] {
  const scripts = [urls.serviceWorkerUrl, urls.sharedWorkerUrl, urls.dedicatedWorkerUrl];
  return scripts.map((url) => ({ urlPattern: `${url}*` }));
}

/** A probe that runs `run` on the attached tab session. */
function onTab(
  id: string,
  description: string,
  run: (context: ProbeContext, tab: Debuggee) => Promise<unknown>,
): ProbeDefinition {
  return {
    id,
    description,
    run: async (context) => {
      const tab = tabDebuggee(context);
      if (!tab) return unavailable("the tab is not attached");
      return attempt(() => run(context, tab));
    },
  };
}

function summarizeTargets(result: CommandResult) {
  const infos = Array.isArray(result.targetInfos) ? (result.targetInfos as CommandResult[]) : [];
  const types = [...new Set(infos.map((info) => String(info.type)))];
  // Browser-wide when it lists targets of other tabs or of extensions, not only this tab's tree.
  const pages = infos.filter((info) => info.type === "page").length;
  const extensions = infos.filter((info) => String(info.url).startsWith("chrome-extension://"));
  return {
    count: infos.length,
    types,
    pages,
    browserWide: pages > 1 || extensions.length > 0,
    urls: infos.map((info) => `${String(info.type)} ${String(info.url)}`),
  };
}

const tabGetTargets = onTab(
  "tab-target-get-targets",
  "Target.getTargets sent on the tab session: does it list browser-wide targets?",
  async (context, tab) => summarizeTargets(await send(context, tab, "Target.getTargets")),
);

const tabAttachToServiceWorker: ProbeDefinition = {
  id: "tab-attach-to-service-worker",
  description:
    "Target.attachToTarget({ flatten: true }) to the service worker, from the tab session",
  run: async (context) => {
    const tab = tabDebuggee(context);
    const worker = findTarget(context.state.targets, context.urls.serviceWorkerUrl);
    if (!tab || !worker)
      return unavailable("the tab is not attached or no service worker is listed");
    return attempt(async () => {
      const params = { targetId: worker.id, flatten: true };
      const { sessionId } = await send(context, tab, "Target.attachToTarget", params);
      await send(context, tab, "Target.detachFromTarget", { sessionId });
      return { sessionId: typeof sessionId === "string" };
    });
  },
};

const serviceWorkerEnable = onTab(
  "service-worker-enable",
  "ServiceWorker.enable on the tab session",
  async (context, tab) => {
    await send(context, tab, "ServiceWorker.enable");
    await send(context, tab, "ServiceWorker.disable");
  },
);

const fetchEnable = onTab(
  "fetch-enable-worker-scripts",
  "Fetch.enable with patterns on the worker scripts, on the tab session",
  async (context, tab) => {
    const patterns = workerScriptPatterns(context.urls);
    await send(context, tab, "Fetch.enable", { patterns });
    await send(context, tab, "Fetch.disable");
    return { patterns: patterns.length };
  },
);

const storageGetCookies = onTab(
  "storage-get-cookies",
  "Storage.getCookies on the tab session (count only; values are never recorded)",
  async (context, tab) => {
    const { cookies } = await send(context, tab, "Storage.getCookies");
    return { count: Array.isArray(cookies) ? cookies.length : null };
  },
);

const networkSetCookie = onTab(
  "network-set-cookie",
  "Network.setCookie on the fixture origin, then Network.deleteCookies",
  async (context, tab) => {
    const url = context.urls.cookieUrl;
    const set = await send(context, tab, "Network.setCookie", {
      name: PROBE_COOKIE,
      value: "1",
      url,
    });
    await send(context, tab, "Network.deleteCookies", { name: PROBE_COOKIE, url });
    return { success: set.success ?? null };
  },
);

const networkEnable = onTab(
  "network-enable",
  "Network.enable on the tab session",
  async (context, tab) => {
    await send(context, tab, "Network.enable");
    await send(context, tab, "Network.disable");
  },
);

const addScript = onTab(
  "page-add-script-on-new-document",
  "Page.addScriptToEvaluateOnNewDocument on the tab session, then removed",
  async (context, tab) => {
    const { identifier } = await send(context, tab, "Page.addScriptToEvaluateOnNewDocument", {
      source: "void 0;",
    });
    await send(context, tab, "Page.removeScriptToEvaluateOnNewDocument", { identifier });
    return { identifier: typeof identifier === "string" };
  },
);

export const TAB_DOMAIN_PROBES: ProbeDefinition[] = [
  tabGetTargets,
  tabAttachToServiceWorker,
  serviceWorkerEnable,
  fetchEnable,
  storageGetCookies,
  networkSetCookie,
  networkEnable,
  addScript,
];
