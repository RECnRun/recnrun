// The lab's switch coordinator. Phase 1 keeps its state in memory; Phase 3 needs a journal.
import { marked, navigate } from "./navigation.js";
import { getCapture, putCapture } from "./repo.js";

export const options = {
  candidate: "a1",
  delayMs: 0,
  timeoutMs: 20000,
  clear: { timeoutMs: 5000, probe: false },
  replace: true,
  // The identity a tab has before its first switch.
  firstIdentity: "profile",
};
const EMPTY = { local: [], session: [], databases: [] };
const tabs = new Map();
const pending = new Map();

function expectReport(nonce, context) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no report from the ${options.candidate} script`)),
      options.timeoutMs,
    );
    const settle = (action) => (value) => {
      clearTimeout(timer);
      action(value);
    };
    pending.set(nonce, { ...context, resolve: settle(resolve), reject: settle(reject) });
  });
}

const CSP_RULE = 1;

function cspRule(add) {
  const rule = {
    id: CSP_RULE,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "set", value: "script-src 'none'" },
      ],
    },
    condition: { urlFilter: "__recnrun_gate=", resourceTypes: ["main_frame", "sub_frame"] },
  };
  return chrome.declarativeNetRequest.updateSessionRules(
    add ? { removeRuleIds: [CSP_RULE], addRules: [rule] } : { removeRuleIds: [CSP_RULE] },
  );
}

async function viaGate(nonce, context, urls) {
  const mode = options.candidate;
  if (mode === "a2") await cspRule(true);
  try {
    const report = expectReport(nonce, context);
    const navigation = { replace: options.replace };
    const gateUrl = marked(urls.current, "__recnrun_gate", `${nonce}.${mode}`);
    const gate = await navigate(context.tabId, gateUrl, navigation);
    const done = await report;
    const document = await navigate(context.tabId, urls.final, navigation);
    return { gate, document, report: done };
  } finally {
    if (mode === "a2") await cspRule(false);
  }
}

async function viaA0(nonce, context, urls) {
  const report = expectReport(nonce, context);
  // A0 captures and clears in the running application document, then restores in the next one.
  await chrome.scripting.executeScript({
    target: { tabId: context.tabId },
    args: [nonce],
    func: async (id) => {
      const captured = await self.__originLab.captureAll();
      const ack = await chrome.runtime.sendMessage({ a0: "captured", nonce: id, captured });
      if (!ack?.ok) throw new Error(ack?.error ?? "the capture was not persisted");
      await self.__originLab.clearAll();
    },
  });
  const document = await navigate(context.tabId, marked(urls.final, "__recnrun_a0", nonce));
  return { document, report: await report };
}

/** The capture `to` resumes from, if any, and what kind of switch that makes. */
async function targetOf(origin, to, reset) {
  if (reset) return { kind: "reset", target: EMPTY };
  const stored = await getCapture(origin, to);
  return stored
    ? { kind: "resume", target: stored.state, lastUrl: stored.lastUrl }
    : { kind: "start", target: EMPTY };
}

async function plan(tabId, to, { reset = false, url } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const origin = new URL(tab.url).origin;
  const state = tabs.get(tabId) ?? { identity: options.firstIdentity, urls: {} };
  if (state.identity === "unknown") throw new Error("the tab is in an unknown state");
  const { kind, target, lastUrl } = await targetOf(origin, to, reset);
  const current = marked(tab.url);
  const context = {
    tabId,
    origin,
    from: state.identity,
    to,
    kind,
    target,
    lastUrl: current,
    marks: { started: performance.now() },
  };
  const final = url ?? state.urls[to] ?? lastUrl ?? current;
  return { state, context, urls: { current, final: marked(final) } };
}

/** Suspends the tab's identity and starts or resumes `to`, with the configured candidate. */
export async function switchTo(tabId, to, settings) {
  const { state, context, urls } = await plan(tabId, to, settings);
  const nonce = crypto.randomUUID();
  const run = options.candidate === "a0" ? viaA0 : viaGate;
  try {
    const result = await run(nonce, context, urls);
    state.urls[context.from] = urls.current;
    tabs.set(tabId, { ...state, identity: to });
    const ms = performance.now() - context.marks.started;
    return {
      from: context.from,
      to,
      kind: context.kind,
      candidate: options.candidate,
      ms,
      ...result,
    };
  } catch (error) {
    tabs.set(tabId, { ...state, identity: "unknown" });
    throw error;
  } finally {
    pending.delete(nonce);
  }
}

const relative = (context) =>
  Object.fromEntries(
    Object.entries(context.marks).map(([name, at]) => [name, at - context.marks.started]),
  );

async function persist(context, captured) {
  context.marks.captured = performance.now();
  const { ms: _ms, ...state } = captured;
  await putCapture({
    origin: context.origin,
    identity: context.from,
    lastUrl: context.lastUrl,
    capturedAt: Date.now(),
    state,
  });
  context.marks.persisted = performance.now();
  return { ok: true, target: context.target };
}

/** Messages from the gate and A0 scripts; only a pending switch's nonce gets an answer. */
export async function onPageMessage(message, sender) {
  const step = message.gate ?? message.a0;
  const context = pending.get(message.nonce);
  if (!context || sender.tab?.id !== context.tabId) return { ok: false, error: "unknown switch" };
  if (step === "ready") {
    context.marks.ready = performance.now();
    context.ready = { href: message.href, topLevel: message.topLevel, scripts: message.scripts };
    return { ok: true, delayMs: options.delayMs, clear: options.clear, target: context.target };
  }
  if (step === "captured") return persist(context, message.captured);
  context.marks[step] = performance.now();
  if (step === "done")
    context.resolve({ ...message, ready: context.ready, marks: relative(context) });
  else context.reject(new Error(message.error));
  return { ok: true };
}

export function forgetTabs() {
  tabs.clear();
}
