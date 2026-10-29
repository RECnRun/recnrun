import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";

type ResourceType = `${Browser.declarativeNetRequest.ResourceType}`;

export interface BarrierRule {
  id: number;
  priority: number;
  action: {
    type: "allow" | "block" | "modifyHeaders";
    requestHeaders?: { header: string; operation: "remove" }[];
    responseHeaders?: (
      | { header: string; operation: "append"; value: string }
      | { header: string; operation: "remove" }
    )[];
  };
  condition: {
    tabIds: number[];
    resourceTypes?: ResourceType[];
    excludedResourceTypes?: ResourceType[];
    urlFilter?: string;
    responseHeaders?: { header: string; values: string[]; excludedValues: string[] }[];
  };
}

export interface AgentScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: "document_start";
  allFrames: false;
  persistAcrossSessions: false;
}

export interface BarrierApi {
  addSessionRules: (rules: BarrierRule[]) => Promise<void>;
  removeSessionRules: (ids: number[]) => Promise<void>;
  sessionRuleIds: () => Promise<number[]>;
  registerScript: (script: AgentScript) => Promise<void>;
  unregisterScript: (id: string) => Promise<void>;
  registeredScriptIds: () => Promise<string[]>;
}

export interface BarrierOperation {
  id: string;
  generation: number;
}

export interface Barrier {
  ruleIds: number[];
  scriptId: string;
}

/** Appended to the tab's documents: the site's own scripts never run before the agent restores. */
export const BARRIER_CSP =
  "script-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'";
/** Where WXT emits the runtime-registered origin agent. */
export const AGENT_SCRIPT = "content-scripts/origin-agent.js";

const RULES_PER_GENERATION = 10;
const RULES_PER_BARRIER = 6;

function requireOrigin(target: string): void {
  const url = URL.parse(target);
  const web = url?.protocol === "http:" || url?.protocol === "https:";
  if (!web || url.origin !== target) {
    throw new WorkspaceError(
      "TargetNotAllowed",
      "The barrier guards one http or https origin only.",
    );
  }
}

/**
 * Header value patterns of a Location that may leave the origin, lowercased by Chrome
 * (request_params.cc:70-86, base::MatchPattern: `*` any run, `?` one optional, `\` escapes):
 * a scheme's colon, two slashes or backslashes in any mix, or a tab the URL parser drops.
 */
const LEAVING = ["*:*", "*//*", "*/\\\\*", "*\\\\/*", "*\\\\\\\\*", "*\t*"];

/**
 * Strips a cross-origin redirect behind the barrier, so the document commits on the origin and the
 * reload, once the barrier is gone, follows it; same-origin redirects are followed at once.
 */
function handOverRule(id: number, tabIds: number[], origin: string): BarrierRule {
  return {
    id,
    priority: 3,
    action: {
      type: "modifyHeaders",
      responseHeaders: [{ header: "location", operation: "remove" }],
    },
    condition: {
      tabIds,
      resourceTypes: ["main_frame"],
      responseHeaders: [
        {
          header: "location",
          values: LEAVING,
          excludedValues: [origin, `${origin}/*`, `${origin}\\?*`, `${origin}#*`],
        },
      ],
    },
  };
}

/**
 * A helper tab's document loads as no one: its request sends no cookie, so the site acts on no
 * session, and a `Set-Cookie` in its response never reaches the identity's store.
 */
function anonymousRule(id: number, tabIds: number[]): BarrierRule {
  return {
    id,
    priority: 3,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "cookie", operation: "remove" }],
      responseHeaders: [{ header: "set-cookie", operation: "remove" }],
    },
    condition: { tabIds, resourceTypes: ["main_frame"] },
  };
}

/** Blocks everything in the tab, then lets only the target origin's documents through, script-free. */
function barrierRules(tabId: number, origin: string, generation: number): BarrierRule[] {
  const base = generation * RULES_PER_GENERATION;
  const tabIds = [tabId];
  return [
    {
      id: base + 1,
      priority: 1,
      action: { type: "block" },
      condition: { tabIds, excludedResourceTypes: ["main_frame"] },
    },
    {
      id: base + 2,
      priority: 1,
      action: { type: "block" },
      condition: { tabIds, resourceTypes: ["main_frame"] },
    },
    {
      id: base + 3,
      priority: 2,
      action: { type: "allow" },
      condition: { tabIds, resourceTypes: ["main_frame"], urlFilter: `|${origin}/` },
    },
    // Above the allow rule: an allow that outranks a modifyHeaders rule suppresses it.
    {
      id: base + 4,
      priority: 3,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Content-Security-Policy", operation: "append", value: BARRIER_CSP },
        ],
      },
      condition: { tabIds, resourceTypes: ["main_frame", "sub_frame"] },
    },
    handOverRule(base + 5, tabIds, origin),
  ];
}

const agentScriptId = (operationId: string) => `recnrun-origin-agent-${operationId}`;

/**
 * The rule and script ids an operation's barrier uses, known without the tab or the origin; the
 * anonymous rule's id is always among them, and Chrome ignores removing an id it lacks
 * (rules_monitor_service.cc:817-819).
 */
export function barrierOf({ id, generation }: BarrierOperation): Barrier {
  const base = generation * RULES_PER_GENERATION;
  const ruleIds = Array.from({ length: RULES_PER_BARRIER }, (_, index) => base + index + 1);
  return { ruleIds, scriptId: agentScriptId(id) };
}

function agentScript(origin: string, operationId: string): AgentScript {
  return {
    id: agentScriptId(operationId),
    js: [AGENT_SCRIPT],
    matches: [`${origin}/*`],
    runAt: "document_start",
    allFrames: false,
    persistAcrossSessions: false,
  };
}

async function requireFree(barrier: Barrier, api: BarrierApi): Promise<void> {
  const rules = new Set(await api.sessionRuleIds());
  const scripts = new Set(await api.registeredScriptIds());
  if (barrier.ruleIds.some((id) => rules.has(id)) || scripts.has(barrier.scriptId)) {
    throw new WorkspaceError(
      "BarrierCollision",
      "Another workspace operation still holds this barrier.",
    );
  }
}

/** Installs the rules and the origin agent; on failure, leaves nothing behind. */
async function install(
  rules: BarrierRule[],
  script: AgentScript,
  barrier: Barrier,
  api: BarrierApi,
): Promise<Barrier> {
  await requireFree(barrier, api);
  await api.addSessionRules(rules);
  try {
    await api.registerScript(script);
  } catch {
    await api.removeSessionRules(barrier.ruleIds);
    throw new WorkspaceError("BarrierNotInstalled", "Chrome did not register the origin agent.");
  }
  return barrier;
}

/** Installs the tab's barrier and the origin agent; on failure, leaves nothing behind. */
export async function installBarrier(
  tabId: number,
  origin: string,
  operation: BarrierOperation,
  api: BarrierApi,
): Promise<Barrier> {
  requireOrigin(origin);
  const rules = barrierRules(tabId, origin, operation.generation);
  return await install(rules, agentScript(origin, operation.id), barrierOf(operation), api);
}

/** The barrier for a helper tab, which also keeps the identity's cookies out of its document's exchange. */
export async function installAnonymousBarrier(
  tabId: number,
  origin: string,
  operation: BarrierOperation,
  api: BarrierApi,
): Promise<Barrier> {
  requireOrigin(origin);
  const barrier = barrierOf(operation);
  const rules = barrierRules(tabId, origin, operation.generation);
  rules.push(anonymousRule(barrier.ruleIds[RULES_PER_BARRIER - 1] ?? 0, [tabId]));
  return await install(rules, agentScript(origin, operation.id), barrier, api);
}

/** Removes this barrier only, then asks Chrome again to prove it is gone. */
export async function removeBarrier(barrier: Barrier, api: BarrierApi): Promise<void> {
  await api.removeSessionRules(barrier.ruleIds);
  // Chrome rejects unregistering an id it does not know, as after an earlier removal.
  if ((await api.registeredScriptIds()).includes(barrier.scriptId)) {
    await api.unregisterScript(barrier.scriptId);
  }
  const rules = new Set(await api.sessionRuleIds());
  const scripts = await api.registeredScriptIds();
  if (barrier.ruleIds.some((id) => rules.has(id)) || scripts.includes(barrier.scriptId)) {
    throw new WorkspaceError(
      "BarrierNotRemoved",
      "Chrome still lists the barrier after removing it.",
    );
  }
}

/** The barrier's Chrome APIs; the rule and script shapes above are Chrome's, minus its enum types. */
export const chromeBarrierApi: BarrierApi = {
  addSessionRules: (rules) =>
    browser.declarativeNetRequest.updateSessionRules({
      addRules: rules as unknown as Browser.declarativeNetRequest.Rule[],
    }),
  removeSessionRules: (ids) =>
    browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }),
  sessionRuleIds: async () =>
    (await browser.declarativeNetRequest.getSessionRules()).map(({ id }) => id),
  registerScript: (script) =>
    browser.scripting.registerContentScripts([script as Browser.scripting.RegisteredContentScript]),
  unregisterScript: (id) => browser.scripting.unregisterContentScripts({ ids: [id] }),
  registeredScriptIds: async () =>
    (await browser.scripting.getRegisteredContentScripts()).map(({ id }) => id),
};
