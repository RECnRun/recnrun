import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { WorkspaceError } from "@/background/workspace/errors";
import { BARRIER_DOCUMENT_TYPE } from "@/messaging/origin-protocol";

type ResourceType = `${Browser.declarativeNetRequest.ResourceType}`;

export interface BarrierRule {
  id: number;
  priority: number;
  action: {
    type: "allow" | "block" | "modifyHeaders";
    requestHeaders?: { header: string; operation: "remove" }[];
    responseHeaders?: (
      | { header: string; operation: "append" | "set"; value: string }
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

/** A content script registered at run time; the origin agent's runs in the top frame only. */
export interface AgentScript {
  id: string;
  js: string[];
  matches: string[];
  runAt: "document_start";
  allFrames: boolean;
  world?: "ISOLATED" | "MAIN";
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
  /** Which of the operation's barriers this is, so two can stand at once; 0 when left out. */
  lane?: number;
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

/**
 * A barrier document commits as plain text of its own type, unsniffed: it shows no title, runs no
 * meta refresh, and its agent hides it; a type Chrome cannot render, or an attachment, would make
 * it a download, which fails a non-2xx response (navigation_url_loader_impl.cc:1516-1532,
 * navigation_request.cc:988-991).
 */
const PLAIN_TEXT: NonNullable<BarrierRule["action"]["responseHeaders"]> = [
  { header: "content-type", operation: "set", value: BARRIER_DOCUMENT_TYPE },
  { header: "x-content-type-options", operation: "set", value: "nosniff" },
  { header: "content-disposition", operation: "remove" },
];

const RULES_PER_BARRIER = 6;
/** A start's primary tab and its reopened tabs each hold a barrier while the other loads. */
const BARRIER_LANES = 2;
const RULES_PER_GENERATION = 20;

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
function barrierRules(tabId: number, origin: string, operation: BarrierOperation): BarrierRule[] {
  const base = baseOf(operation);
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
          ...PLAIN_TEXT,
        ],
      },
      condition: { tabIds, resourceTypes: ["main_frame", "sub_frame"] },
    },
    handOverRule(base + 5, tabIds, origin),
  ];
}

const baseOf = ({ generation, lane = 0 }: BarrierOperation) =>
  generation * RULES_PER_GENERATION + lane * RULES_PER_BARRIER;

const agentScriptId = ({ id, lane = 0 }: BarrierOperation) =>
  lane === 0 ? `recnrun-origin-agent-${id}` : `recnrun-origin-agent-${id}-${lane}`;

/**
 * The rule and script ids one of an operation's barriers uses, known without the tab or the
 * origin; the anonymous rule's id is always among them, and Chrome ignores removing an id it lacks
 * (rules_monitor_service.cc:817-819).
 */
export function barrierOf(operation: BarrierOperation): Barrier {
  const base = baseOf(operation);
  const ruleIds = Array.from({ length: RULES_PER_BARRIER }, (_, index) => base + index + 1);
  return { ruleIds, scriptId: agentScriptId(operation) };
}

function agentScript(origin: string, operation: BarrierOperation): AgentScript {
  return {
    id: agentScriptId(operation),
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
  const rules = barrierRules(tabId, origin, operation);
  return await install(rules, agentScript(origin, operation), barrierOf(operation), api);
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
  const rules = barrierRules(tabId, origin, operation);
  rules.push(anonymousRule(barrier.ruleIds[RULES_PER_BARRIER - 1] ?? 0, [tabId]));
  return await install(rules, agentScript(origin, operation), barrier, api);
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

/** Removes the barrier of each of the operation's lanes, trying every one even after a failure. */
export async function removeBarriersOf(
  operation: Omit<BarrierOperation, "lane">,
  api: BarrierApi,
): Promise<void> {
  const failures: unknown[] = [];
  for (let lane = 0; lane < BARRIER_LANES; lane += 1) {
    await removeBarrier(barrierOf({ ...operation, lane }), api).catch((error: unknown) => {
      failures.push(error);
    });
  }
  if (failures.length > 0) throw failures[0];
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
