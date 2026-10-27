// The lab's switch coordinator. Phase 1 keeps its state in memory; Phase 3 needs a journal.
import { marked, navigate } from "./navigation.js";
import { captureCookies, replaceCookies, storeOf } from "./cookies.js";
import {
  companionsOf,
  park,
  partitionOf,
  restoreSessions,
  retitle,
  sessionFor,
  sessionsOf,
  unpark,
} from "./group.js";
import { getCapture, hasCaptures, putCapture } from "./repo.js";

export const options = {
  candidate: "a1",
  delayMs: 0,
  timeoutMs: 20000,
  clear: { timeoutMs: 5000, probe: false },
  replace: true,
  // The identity a tab has before its first switch.
  firstIdentity: "profile",
  // Experiment D: hosts whose cookies are part of the snapshot, such as a sign-in server.
  cookieHosts: [],
};
const EMPTY = { local: [], session: [], databases: [], cookies: [] };
// The identity each origin has, per storage partition: every tab of it shares that storage.
const identities = new Map();
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
      const report = async (step, extra) => {
        const ack = await chrome.runtime.sendMessage({ a0: step, nonce: id, ...extra });
        if (!ack?.ok) throw new Error(ack?.error ?? `the ${step} step was refused`);
      };
      await report("captured", { captured: await self.__originLab.captureAll() });
      await report("clearing");
      await self.__originLab.clearAll();
      await report("cleared");
    },
  });
  const document = await navigate(context.tabId, marked(urls.final, "__recnrun_a0", nonce));
  return { document, report: await report };
}

/** The capture `to` resumes from, if any, and what kind of switch that makes. */
async function targetOf({ origin, partition }, to, reset) {
  if (reset) return { kind: "reset", target: EMPTY };
  const stored = await getCapture(origin, to, partition);
  return stored
    ? { kind: "resume", target: stored.state, lastUrl: stored.lastUrl }
    : { kind: "start", target: EMPTY };
}

/** The origin's identity in this partition, if a switch from it to `to` may start. */
async function stateOf({ partition, origin }, key, to, reset) {
  // Identities live in the worker's memory: after Chrome restarts it, guessing would file one
  // identity's storage under another's name.
  if (!identities.has(key) && (await hasCaptures(partition, origin))) {
    throw new Error(
      `the lab lost track of ${origin}'s identity (its service worker restarted); run lab.reset() and start over`,
    );
  }
  const state = identities.get(key) ?? { identity: options.firstIdentity, urls: {} };
  if (state.identity === "unknown") throw new Error("the tab is in an unknown state");
  // Its suspend would overwrite the identity's capture with the state it is about to clear.
  if (state.identity === to && !reset) throw new Error(`the tab is already ${to}`);
  return state;
}

async function plan(tabId, to, { reset = false, url } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const where = { origin: new URL(tab.url).origin, partition: partitionOf(tab) };
  const key = `${where.partition}|${where.origin}`;
  const state = await stateOf(where, key, to, reset);
  // Each tab goes back to the URL it had under `to`, or stays where it is.
  const left = state.urls[to] ?? {};
  const companions = (await companionsOf(tab, options.cookieHosts)).map((companion) => ({
    ...companion,
    next: left[companion.id] ?? companion.url,
  }));
  const { kind, target, lastUrl } = await targetOf(where, to, reset);
  const current = marked(tab.url);
  const context = {
    tabId,
    ...where,
    storeId: await storeOf(tabId),
    from: state.identity,
    to,
    kind,
    target,
    lastUrl: current,
    marks: { started: performance.now() },
  };
  const final = url ?? left[tabId] ?? lastUrl ?? current;
  return { tab, key, state, companions, context, urls: { current, final: marked(final) } };
}

/** Parks the companions, switches the lead with the configured candidate, then the companions. */
async function acrossTabs(nonce, { companions, context, urls }) {
  await park(companions, nonce);
  context.sessions = await sessionsOf(companions);
  const run = options.candidate === "a0" ? viaA0 : viaGate;
  const result = await run(nonce, context, urls);
  await restoreSessions(companions, context.target);
  await unpark(companions);
  return result;
}

/** The origin is now `to`; each tab's URL is kept for when it comes back to `from`. */
function remember({ key, state, companions, context, urls }) {
  state.urls[context.from] = Object.fromEntries([
    [context.tabId, urls.current],
    ...companions.map((companion) => [companion.id, companion.url]),
  ]);
  identities.set(key, { ...state, identity: context.to });
}

/** Suspends the tab's identity and starts or resumes `to` in every tab of its group. */
export async function switchTo(tabId, to, settings) {
  const planned = await plan(tabId, to, settings);
  const { tab, companions, context } = planned;
  const nonce = crypto.randomUUID();
  try {
    const result = await acrossTabs(nonce, planned);
    await retitle(tab, to);
    remember(planned);
    const ms = performance.now() - context.marks.started;
    return {
      from: context.from,
      to,
      kind: context.kind,
      candidate: options.candidate,
      tabs: 1 + companions.length,
      ms,
      ...result,
    };
  } catch (error) {
    throw await giveUp(nonce, planned, error);
  } finally {
    pending.delete(nonce);
  }
}

/**
 * A switch that failed before any clearing changed nothing: the tabs go back to their URLs and
 * keep the identity. After it, the origin's state is unknown.
 */
async function giveUp(nonce, { key, state, companions, context, urls }, error) {
  // From here the page's "clearing" gets no answer, so it cannot start once this decided.
  pending.delete(nonce);
  if (context.marks.clearing) {
    identities.set(key, { ...state, identity: "unknown" });
    return error;
  }
  identities.set(key, state);
  await navigate(context.tabId, urls.current, { replace: options.replace });
  await unpark(companions.map((companion) => ({ ...companion, next: companion.url })));
  return new Error(`${error.message} (nothing changed; the tabs are back)`);
}

const relative = (context) =>
  Object.fromEntries(
    Object.entries(context.marks).map(([name, at]) => [name, at - context.marks.started]),
  );

async function persist(context, captured) {
  context.marks.captured = performance.now();
  const { ms: _ms, ...state } = captured;
  const cookies = await captureCookies(options.cookieHosts, context.storeId);
  await putCapture({
    partition: context.partition,
    origin: context.origin,
    identity: context.from,
    lastUrl: context.lastUrl,
    capturedAt: Date.now(),
    state: { ...state, tabs: { ...context.sessions, [context.tabId]: state.session }, cookies },
  });
  context.marks.persisted = performance.now();
  return { ok: true, target: pageTarget(context) };
}

/** Swapped only once the storage is cleared, while the page holds the app off. */
async function swapCookies(context) {
  context.marks.cleared = performance.now();
  const target = context.target.cookies ?? [];
  context.cookies = await replaceCookies(options.cookieHosts, target, context.storeId);
  return { ok: true };
}

/** The target as a page script gets it: its own tab's storage, never the cookies. */
function pageTarget(context) {
  const { cookies: _cookies, tabs: _tabs, ...storage } = context.target;
  return { ...storage, session: sessionFor(context.target, context.tabId) };
}

function onReady(context, message) {
  context.marks.ready = performance.now();
  context.ready = { href: message.href, topLevel: message.topLevel, scripts: message.scripts };
  // A0 captured before its document loaded, so it restores from this reply; the gate waits.
  const target = message.a0 ? pageTarget(context) : undefined;
  return { ok: true, delayMs: options.delayMs, clear: options.clear, target };
}

function onDone(context, message) {
  context.marks.done = performance.now();
  context.resolve({
    ...message,
    ready: context.ready,
    cookies: context.cookies,
    marks: relative(context),
  });
  return { ok: true };
}

const steps = {
  ready: onReady,
  captured: (context, message) => persist(context, message.captured),
  clearing: (context) => {
    context.marks.clearing = performance.now();
    return { ok: true };
  },
  cleared: swapCookies,
  done: onDone,
  failed: (context, message) => {
    context.marks.failed = performance.now();
    context.reject(new Error(message.error));
    return { ok: true };
  },
};

/** Messages from the gate and A0 scripts; only a pending switch's nonce gets an answer. */
export async function onPageMessage(message, sender) {
  const step = message.gate ?? message.a0;
  const context = pending.get(message.nonce);
  if (!context || sender.tab?.id !== context.tabId || !Object.hasOwn(steps, step)) {
    return { ok: false, error: "unknown switch" };
  }
  return steps[step](context, message);
}

/** Forgets the identities of one partition's origins, or of all. */
export function forgetTabs(partition) {
  for (const key of identities.keys()) {
    if (!partition || key.startsWith(`${partition}|`)) identities.delete(key);
  }
}
