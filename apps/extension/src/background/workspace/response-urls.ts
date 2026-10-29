import type { IdentityData, ManagedWindowState } from "@recnrun/domain";
import type { Browser } from "wxt/browser";
import type { AgentScript, BarrierApi } from "@/background/workspace/barrier";
import type { ResponseUrlPairs } from "@/messaging/response-url-protocol";
import type { ResponseUrls, ResponseUrlStore } from "@/ports/response-urls";

/** Where WXT emits the page script that shows restored responses' URLs, and its relay. */
export const RESPONSE_URL_PAGE = "content-scripts/response-url-page.js";
export const RESPONSE_URL_RELAY = "content-scripts/response-url-relay.js";

const PAGE_ID = "recnrun-response-url-page";
const RELAY_ID = "recnrun-response-url-relay";

/** Per origin, the restored entries that were fetched, whose response a page reads without a URL. */
export function responseUrlsOf(origin: string, data: IdentityData): ResponseUrls {
  const urls: ResponseUrls = {};
  for (const { origin: at, caches } of [{ origin, caches: data.site.caches }, ...data.origins]) {
    const pairs = caches.flatMap(({ entries }) =>
      entries.flatMap(({ request, response }): [string, string][] =>
        response.url === "" ? [] : [[request.url, response.url]],
      ),
    );
    if (pairs.length > 0) urls[at] = pairs;
  }
  return urls;
}

function script(id: string, file: string, matches: string[], world: "ISOLATED" | "MAIN") {
  return {
    id,
    js: [file],
    matches,
    runAt: "document_start",
    allFrames: true,
    world,
    persistAcrossSessions: false,
  } satisfies AgentScript;
}

/** Unregisters the page script and its relay, wherever an earlier start left them. */
export async function withdrawResponseUrls(api: BarrierApi): Promise<void> {
  const registered = new Set(await api.registeredScriptIds());
  for (const id of [PAGE_ID, RELAY_ID]) {
    if (registered.has(id)) await api.unregisterScript(id);
  }
}

/**
 * Keeps `urls` for `generation` and registers the page script and its relay on their origins only,
 * replacing an earlier start's; either both are registered or neither.
 */
export async function exposeResponseUrls(
  generation: number,
  urls: ResponseUrls,
  deps: { barrier: BarrierApi; responseUrls: ResponseUrlStore },
): Promise<void> {
  await withdrawResponseUrls(deps.barrier);
  await deps.responseUrls.write(generation, urls);
  const matches = Object.keys(urls).map((origin) => `${origin}/*`);
  if (matches.length === 0) return;
  try {
    await deps.barrier.registerScript(script(RELAY_ID, RESPONSE_URL_RELAY, matches, "ISOLATED"));
    await deps.barrier.registerScript(script(PAGE_ID, RESPONSE_URL_PAGE, matches, "MAIN"));
  } catch (error) {
    await withdrawResponseUrls(deps.barrier);
    throw error;
  }
}

export interface ResponseUrlAnswerDeps {
  responseUrls: Pick<ResponseUrlStore, "read">;
  managed: () => Promise<ManagedWindowState | null>;
}

/**
 * The pairs of the sender frame's origin, for an Incognito tab while the managed session is open:
 * every Incognito window shares its profile's caches, and a normal window has caches of its own.
 */
export async function answerResponseUrls(
  sender: Browser.runtime.MessageSender,
  deps: ResponseUrlAnswerDeps,
): Promise<ResponseUrlPairs> {
  const { origin } = sender;
  if (sender.tab?.incognito !== true || origin === undefined) return [];
  const managed = await deps.managed();
  if (managed?.status !== "active") return [];
  return (await deps.responseUrls.read(managed.generation))[origin] ?? [];
}
