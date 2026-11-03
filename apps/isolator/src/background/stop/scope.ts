import type { Debuggee } from "@/background/probes/types";
import { exceptionText } from "@/background/route-a/attached";
import { EVICT } from "@/background/stop/expressions";
import type { Outcome, Recorder } from "@/background/stop/recorder";
import { loopbackTab, requireLoopbackOrigin, scopeWorkers } from "@/background/stop/targets";
import type { BlockRule } from "@/background/stop/types";

// A client evaluation can wait on the worker's reply, which the page bounds at 5 s.
const EVALUATION_MS = 10_000;

function valueOf(reply: Outcome<Record<string, unknown>>): { value?: unknown; error?: string } {
  if (reply.error !== undefined) return { error: reply.error };
  const failure = exceptionText(reply.value);
  if (failure !== undefined) return { error: failure };
  return { value: (reply.value.result as { value?: unknown } | undefined)?.value ?? null };
}

/** Evaluates `expression` on `target`, attaching for it unless another session of the isolator holds it. */
async function evaluateOn(recorder: Recorder, target: Debuggee, expression: string) {
  const attached = await recorder.attach(target);
  try {
    const params = { expression, awaitPromise: true, returnByValue: true };
    return valueOf(await recorder.send(target, "Runtime.evaluate", params, EVALUATION_MS));
  } finally {
    if (attached.error === undefined) await recorder.detach(target);
  }
}

export async function evaluateOnTab(recorder: Recorder, tabId: number, expression: string) {
  await loopbackTab(recorder, tabId);
  return evaluateOn(recorder, { tabId }, expression);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function closeTabs(recorder: Recorder, origin: string): Promise<number[]> {
  const url = `${origin}/*`;
  const found = await recorder.record({ api: "tabs", method: "query", params: { url } }, () =>
    recorder.apis.tabs.query({ url }),
  );
  const ids = (found.value ?? []).flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
  if (ids.length === 0) return [];
  const call = { api: "tabs" as const, method: "remove", params: { tabIds: ids } };
  const removed = await recorder.record(call, () => recorder.apis.tabs.remove(ids));
  return removed.error === undefined ? ids : [];
}

function evictedBy(workers: { clients: unknown }[], closedTabs: number[]): string {
  if (closedTabs.length > 0) return "tabs.remove";
  const clients = workers.flatMap((worker) =>
    Array.isArray(worker.clients) ? worker.clients : [],
  );
  const navigated = (client: unknown) => (client as { navigated?: unknown }).navigated === true;
  return clients.length > 0 && clients.every(navigated) ? "client.navigate" : "none";
}

/**
 * A session rule that blocks the origin's `/sw-*.js` scripts, then eviction of the workers' window
 * clients: `client.navigate()` evaluated in each worker, and the tabs still on the origin closed.
 */
export async function blockScope(recorder: Recorder, origin: string, ruleId: number) {
  requireLoopbackOrigin(origin);
  const rule: BlockRule = {
    id: ruleId,
    priority: 1,
    action: { type: "block" },
    condition: { regexFilter: `^${escapeRegex(origin)}/sw-[^/?#]*\\.js` },
  };
  const call = { api: "declarativeNetRequest" as const, method: "updateSessionRules" };
  const added = await recorder.record({ ...call, params: { addRules: [rule] } }, () =>
    recorder.apis.dnr.updateSessionRules({ addRules: [rule] }),
  );
  const workers = [];
  for (const worker of await scopeWorkers(recorder, origin)) {
    const evicted = await evaluateOn(recorder, { targetId: worker.id }, EVICT);
    workers.push({ targetId: worker.id, url: worker.url, clients: evicted.value ?? evicted });
  }
  const closedTabs = await closeTabs(recorder, origin);
  return {
    ruleId,
    ruleAdded: added.error === undefined,
    workers,
    closedTabs,
    evictedBy: evictedBy(workers, closedTabs),
  };
}

export async function unblock(recorder: Recorder, ruleIds: number[]) {
  if (ruleIds.length === 0) return { removed: [] };
  const call = { api: "declarativeNetRequest" as const, method: "updateSessionRules" };
  const removed = await recorder.record({ ...call, params: { removeRuleIds: ruleIds } }, () =>
    recorder.apis.dnr.updateSessionRules({ removeRuleIds: ruleIds }),
  );
  return removed.error === undefined ? { removed: ruleIds } : { removed: [], error: removed.error };
}
