// The five ops over a fixed CDP method table; no op takes code, a method name, or params.
import { originOfUrl } from "./job-check.js";

const READ_TEXT = "function () { return this.textContent; }";
const POLL_MS = 100;

export class OpError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const send = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nodeOf = async (target, selector) => {
  const { root } = await send(target, "DOM.getDocument", { depth: 0 });
  const { nodeId } = await send(target, "DOM.querySelector", { nodeId: root.nodeId, selector });
  return nodeId;
};

const requireNode = async (target, selector) => {
  const nodeId = await nodeOf(target, selector);
  if (!nodeId) throw new OpError("NOT_FOUND");
  return nodeId;
};

const nextEvent = (target, method) =>
  new Promise((resolve) => {
    const listener = (source, name) => {
      if (source.tabId !== target.tabId || name !== method) return;
      chrome.debugger.onEvent.removeListener(listener);
      resolve();
    };
    chrome.debugger.onEvent.addListener(listener);
  });

const navigate = async (target, { url }) => {
  const loaded = nextEvent(target, "Page.loadEventFired");
  const { errorText, loaderId } = await send(target, "Page.navigate", { url });
  if (errorText) throw new OpError("NAVIGATION_FAILED");
  await loaded;
  return { loaderId };
};

const wait = async (target, { selector }, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nodeId = await nodeOf(target, selector).catch(() => 0);
    if (nodeId) return { found: true };
    await sleep(POLL_MS);
  }
  throw new OpError("TIMEOUT");
};

const type = async (target, { selector, text }) => {
  await send(target, "DOM.focus", { nodeId: await requireNode(target, selector) });
  await send(target, "Input.insertText", { text });
  return { typed: text.length };
};

const click = async (target, { selector }) => {
  const nodeId = await requireNode(target, selector);
  await send(target, "DOM.scrollIntoViewIfNeeded", { nodeId });
  const { quads } = await send(target, "DOM.getContentQuads", { nodeId });
  const [x1, y1, , , x3, y3] = quads[0];
  const point = { x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: "left", clickCount: 1 };
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send(target, "Input.dispatchMouseEvent", { type, ...point });
  }
  return { clicked: true };
};

const read = async (target, { selector, maxBytes }) => {
  const { object } = await send(target, "DOM.resolveNode", {
    nodeId: await requireNode(target, selector),
  });
  const { result } = await send(target, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: READ_TEXT,
    returnByValue: true,
  });
  await send(target, "Runtime.releaseObject", { objectId: object.objectId });
  return { text: String(result.value).slice(0, maxBytes) };
};

const TABLE = { navigate, wait, type, click, read };
export const MUTATING = new Set(["navigate", "type", "click"]);

const checkOrigin = async (target, entry, origins) => {
  const { frameTree } = await send(target, "Page.getFrameTree");
  const url = frameTree.frame.url;
  if (entry.op === "navigate" && url === "about:blank") return;
  if (!origins.includes(originOfUrl(url))) throw new OpError("FORBIDDEN_ORIGIN");
};

const timeout = (ms) =>
  sleep(ms).then(() => {
    throw new OpError("TIMEOUT");
  });

/** Runs one op and answers its outcome; never throws. */
export const execute = async (target, entry, origins) => {
  try {
    await checkOrigin(target, entry, origins);
    const result = await Promise.race([
      TABLE[entry.op](target, entry.args, entry.timeoutMs),
      timeout(entry.timeoutMs),
    ]);
    return { state: "DONE", result };
  } catch (error) {
    return { state: "FAILED", code: error instanceof OpError ? error.code : String(error) };
  }
};
