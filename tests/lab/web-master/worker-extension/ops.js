// The five ops over a fixed CDP method table; no op takes code, a method name, or params.
import { truncateUtf8, utf8Length } from "./encoding.js";
import { originOfUrl } from "./job-check.js";

const READ_TEXT = "function () { return this.textContent; }";
const POLL_MS = 100;

export class OpError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const INPUT = new Set(["Page.navigate", "Input.insertText", "Input.dispatchMouseEvent"]);

// Every CDP call passes here: nothing is sent once the op's absolute deadline has passed.
const send = async (ctx, method, params = {}) => {
  if (ctx.aborted || Date.now() >= ctx.deadlineAt) throw new OpError("TIMEOUT");
  if (INPUT.has(method)) ctx.dispatched = true;
  return chrome.debugger.sendCommand(ctx.target, method, params);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nodeOf = async (ctx, selector) => {
  const { root } = await send(ctx, "DOM.getDocument", { depth: 0 });
  const { nodeId } = await send(ctx, "DOM.querySelector", { nodeId: root.nodeId, selector });
  return nodeId;
};

const requireNode = async (ctx, selector) => {
  const nodeId = await nodeOf(ctx, selector);
  if (!nodeId) throw new OpError("NOT_FOUND");
  return nodeId;
};

const nextEvent = ({ target }, method) =>
  new Promise((resolve) => {
    const listener = (source, name) => {
      if (source.tabId !== target.tabId || name !== method) return;
      chrome.debugger.onEvent.removeListener(listener);
      resolve();
    };
    chrome.debugger.onEvent.addListener(listener);
  });

const navigate = async (ctx, { url }) => {
  const loaded = nextEvent(ctx, "Page.loadEventFired");
  const { errorText, loaderId } = await send(ctx, "Page.navigate", { url });
  if (errorText) throw new OpError("NAVIGATION_FAILED");
  await loaded;
  return { loaderId };
};

const wait = async (ctx, { selector }) => {
  while (Date.now() < ctx.deadlineAt) {
    const nodeId = await nodeOf(ctx, selector).catch(() => 0);
    if (nodeId) return { found: true };
    await sleep(POLL_MS);
  }
  throw new OpError("TIMEOUT");
};

const type = async (ctx, { selector, text }) => {
  await send(ctx, "DOM.focus", { nodeId: await requireNode(ctx, selector) });
  await send(ctx, "Input.insertText", { text });
  return { typed: text.length };
};

const click = async (ctx, { selector }) => {
  const nodeId = await requireNode(ctx, selector);
  await send(ctx, "DOM.scrollIntoViewIfNeeded", { nodeId });
  const { quads } = await send(ctx, "DOM.getContentQuads", { nodeId });
  const [x1, y1, , , x3, y3] = quads[0];
  const point = { x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: "left", clickCount: 1 };
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send(ctx, "Input.dispatchMouseEvent", { type, ...point });
  }
  return { clicked: true };
};

const read = async (ctx, { selector, maxBytes }) => {
  const { object } = await send(ctx, "DOM.resolveNode", {
    nodeId: await requireNode(ctx, selector),
  });
  const { result } = await send(ctx, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: READ_TEXT,
    returnByValue: true,
  });
  await send(ctx, "Runtime.releaseObject", { objectId: object.objectId });
  const text = truncateUtf8(String(result.value ?? ""), maxBytes);
  // The job's reads share one budget (plan §6); an over-budget read is refused whole.
  if (utf8Length(text) > ctx.readBudget) throw new OpError("READ_BUDGET");
  return { text };
};

const TABLE = { navigate, wait, type, click, read };
export const MUTATING = new Set(["navigate", "type", "click"]);

const checkOrigin = async (ctx, entry, origins) => {
  const { frameTree } = await send(ctx, "Page.getFrameTree");
  const url = frameTree.frame.url;
  if (entry.op === "navigate" && url === "about:blank") return;
  if (!origins.includes(originOfUrl(url))) throw new OpError("FORBIDDEN_ORIGIN");
};

// The preflight and the op share one clock, so neither can outlive the op's deadline.
const attempt = async (ctx, entry, run) => {
  await run.gate?.();
  await checkOrigin(ctx, entry, run.origins);
  return TABLE[entry.op](ctx, entry.args);
};

const expiry = (ctx) =>
  sleep(Math.max(0, ctx.deadlineAt - Date.now())).then(() => {
    ctx.aborted = true;
    throw new OpError("TIMEOUT");
  });

const failure = (ctx, entry, error) => {
  const code = error instanceof OpError ? error.code : String(error);
  // A timeout after a mutation was sent leaves its effect unknown.
  if (code === "TIMEOUT" && ctx.dispatched && MUTATING.has(entry.op)) {
    return { state: "OUTCOME_UNKNOWN", code };
  }
  return { state: "FAILED", code };
};

/** Runs one op against `run.deadlineAt` (absolute) and answers its outcome; never throws. */
export const execute = async (target, entry, run) => {
  const ctx = { target, deadlineAt: run.deadlineAt, readBudget: run.readBudget };
  try {
    const result = await Promise.race([attempt(ctx, entry, run), expiry(ctx)]);
    return { state: "DONE", result };
  } catch (error) {
    ctx.aborted = true;
    return failure(ctx, entry, error);
  }
};
