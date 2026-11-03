import { withMarker } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import type { Debuggee } from "@/background/probes/types";
import { RouteBEngine } from "@/background/route-b/engine";
import { fakeDebugger, NOT_ALLOWED } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

const APP = "http://app.localhost:4600";
const TAB = 7;
const WORKER: Debuggee = { tabId: TAB, sessionId: "s-sw" };
const EXTENSION = "chrome-extension://isolator/";
const PATTERN = "*/sw-*.js*";
const CLASSIC = "fetch('/me');\n";
const MODULE = 'import "./sw-main.js";\n';
const HEADERS = [
  { name: "Content-Type", value: "text/javascript; charset=utf-8" },
  { name: "Content-Length", value: "14" },
  { name: "Cache-Control", value: "no-cache" },
];

function setup(options: FakeOptions = {}, body = CLASSIC) {
  const fake = fakeDebugger({
    ...options,
    replies: {
      "Fetch.getResponseBody": { body: btoa(body), base64Encoded: true },
      ...options.replies,
    },
  });
  let clock = 0;
  const engine = new RouteBEngine(
    () => fake.api,
    () => EXTENSION,
    () => (clock += 5),
  );
  return { ...fake, engine };
}

function armed(engine: RouteBEngine, extra: object = {}) {
  return engine.arm({ tabId: TAB, marker: "m1", urlPattern: PATTERN, ...extra });
}

function attached(type: string, targetId: string, sessionId: string) {
  const targetInfo = { targetId, type, url: `${APP}/${targetId}.js` };
  return { sessionId, waitingForDebugger: true, targetInfo };
}

interface Paused {
  url?: string;
  main?: boolean;
  status?: number;
  contentType?: string;
  resourceType?: string;
}

function paused({ url = `${APP}/sw-main.js`, main = true, status = 200, ...rest }: Paused = {}) {
  const contentType = rest.contentType ?? "text/javascript; charset=utf-8";
  return {
    requestId: "r1",
    request: { url, method: "GET", headers: main ? { "Service-Worker": "script" } : {} },
    resourceType: rest.resourceType ?? "Other",
    responseStatusCode: status,
    responseStatusText: "OK",
    responseHeaders: [{ name: "Content-Type", value: contentType }, ...HEADERS.slice(1)],
  };
}

function on(sent: ReturnType<typeof fakeDebugger>["sent"], target: Debuggee): string[] {
  return sent
    .filter((entry) => entry.target.sessionId === target.sessionId)
    .map((entry) => entry.method);
}

describe("Route B arm and auto-attach", () => {
  test("arms the tab with response-stage interception of the pattern, then auto-attach", async () => {
    const { engine, sent } = setup();
    expect(await armed(engine)).toEqual({ fetchEnable: "ok" });
    expect(sent).toEqual([
      {
        target: { tabId: TAB },
        method: "Fetch.enable",
        params: { patterns: [{ urlPattern: PATTERN, requestStage: "Response" }] },
      },
      {
        target: { tabId: TAB },
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      },
    ]);
  });

  test("enables Fetch on a paused service worker's session before it releases it", async () => {
    const { engine, sent, emit } = setup();
    await armed(engine);
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("service_worker", "sw", "s-sw"));
    emit({ tabId: TAB }, "Target.attachedToTarget", attached("iframe", "frame", "s-frame"));
    const { workers } = await engine.journal();
    expect(on(sent, WORKER)).toEqual(["Fetch.enable", "Runtime.runIfWaitingForDebugger"]);
    expect(on(sent, { sessionId: "s-frame" })).toEqual(["Runtime.runIfWaitingForDebugger"]);
    expect(
      workers.map(({ targetId, fetchEnable, released }) => [targetId, fetchEnable, released]),
    ).toEqual([
      ["sw", "ok", true],
      ["frame", "skipped", true],
    ]);
  });

  test("keeps Chrome's error for Fetch.enable and still releases the worker", async () => {
    const refused = setup({ refused: { "Fetch.enable": NOT_ALLOWED } });
    expect(await armed(refused.engine)).toEqual({ fetchEnable: NOT_ALLOWED });
    refused.emit(
      { tabId: TAB },
      "Target.attachedToTarget",
      attached("service_worker", "sw", "s-sw"),
    );
    const [worker] = (await refused.engine.journal()).workers;
    expect([worker?.fetchEnable, worker?.released]).toEqual([NOT_ALLOWED, true]);
    const tabOnly = setup();
    await armed(tabOnly.engine, { workerFetch: false, tabFetch: false });
    tabOnly.emit(
      { tabId: TAB },
      "Target.attachedToTarget",
      attached("service_worker", "sw", "s-sw"),
    );
    await tabOnly.engine.journal();
    expect(tabOnly.sent.map((entry) => entry.method)).toEqual([
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
  });
});

describe("Route B paused scripts", () => {
  test("fulfills a service worker's main script with the bootstrap prepended", async () => {
    const { engine, sent, emit } = setup();
    await armed(engine);
    emit(WORKER, "Fetch.requestPaused", paused());
    const { paused: entries } = await engine.journal();
    const wrapped = `${withMarker("m1")};\n${CLASSIC}`;
    expect(on(sent, WORKER)).toEqual(["Fetch.getResponseBody", "Fetch.fulfillRequest"]);
    expect(sent.at(-1)?.params).toEqual({
      requestId: "r1",
      responseCode: 200,
      responsePhrase: "OK",
      responseHeaders: [HEADERS[0], HEADERS[2]],
      body: btoa(wrapped),
    });
    expect(entries).toEqual([
      {
        session: "worker",
        sessionId: "s-sw",
        url: `${APP}/sw-main.js`,
        resourceType: "Other",
        stage: "response",
        role: "main",
        status: 200,
        action: "fulfilled",
        declared: "transformed",
        wrapper: "prepend",
        originalBytes: CLASSIC.length,
        fulfilledBytes: wrapped.length,
        pausedAt: 5,
        waitedMs: 5,
      },
    ]);
  });

  test("imports the bootstrap module first in a module script with static imports", async () => {
    const { engine, sent, emit } = setup({}, MODULE);
    await armed(engine);
    emit(WORKER, "Fetch.requestPaused", paused({ url: `${APP}/sw-static.js` }));
    const [entry] = (await engine.journal()).paused;
    const first = `import "${EXTENSION}route-b/bootstrap.js?marker=m1";\n`;
    expect(sent.at(-1)?.params).toMatchObject({ body: btoa(`${first}${MODULE}`) });
    expect(entry?.wrapper).toBe("module-import");
  });

  test("lets imported scripts through unless asked to transform them", async () => {
    const plain = setup();
    await armed(plain.engine);
    plain.emit(WORKER, "Fetch.requestPaused", paused({ main: false, resourceType: "Script" }));
    const [continued] = (await plain.engine.journal()).paused;
    expect(on(plain.sent, WORKER)).toEqual(["Fetch.continueRequest"]);
    expect([continued?.role, continued?.action, continued?.declared]).toEqual([
      "imported",
      "continued",
      undefined,
    ]);
    const transform = setup();
    await armed(transform.engine, { imports: "transform" });
    transform.emit(WORKER, "Fetch.requestPaused", paused({ main: false, resourceType: "Script" }));
    const [fulfilled] = (await transform.engine.journal()).paused;
    expect([fulfilled?.role, fulfilled?.declared]).toEqual(["imported", "transformed"]);
  });

  test("lets through what is not a script, a failed response, and a page's own script", async () => {
    const { engine, sent, emit } = setup();
    await armed(engine);
    emit(WORKER, "Fetch.requestPaused", paused({ contentType: "text/html" }));
    emit(WORKER, "Fetch.requestPaused", paused({ status: 404 }));
    emit(WORKER, "Fetch.requestPaused", { ...paused(), responseErrorReason: "Failed" });
    emit(WORKER, "Fetch.requestPaused", paused({ main: false, resourceType: "Fetch" }));
    emit({ tabId: TAB }, "Fetch.requestPaused", paused({ main: false, resourceType: "Script" }));
    emit({ tabId: TAB }, "Fetch.requestPaused", { ...paused(), responseStatusCode: undefined });
    const entries = (await engine.journal()).paused;
    expect(sent.filter((entry) => entry.method.startsWith("Fetch.")).map((e) => e.method)).toEqual([
      "Fetch.enable",
      ...Array<string>(6).fill("Fetch.continueRequest"),
    ]);
    expect(entries.map(({ session, stage, action }) => `${session} ${stage} ${action}`)).toEqual([
      ...Array<string>(4).fill("worker response continued"),
      "tab response continued",
      "tab request continued",
    ]);
  });

  test("never wraps a worker's own fetch() of a script, even when transforming imports", async () => {
    const { engine, sent, emit } = setup();
    await armed(engine, { imports: "transform" });
    emit(WORKER, "Fetch.requestPaused", paused({ main: false, resourceType: "XHR" }));
    const [entry] = (await engine.journal()).paused;
    expect(on(sent, WORKER)).toEqual(["Fetch.continueRequest"]);
    expect([entry?.role, entry?.action]).toEqual([undefined, "continued"]);
  });

  test("records Chrome's error reason for a response that failed", async () => {
    const { engine, emit } = setup();
    await armed(engine);
    emit(WORKER, "Fetch.requestPaused", {
      ...paused({ main: false, resourceType: "XHR" }),
      responseStatusCode: undefined,
      responseErrorReason: "AccessDenied",
    });
    const [entry] = (await engine.journal()).paused;
    expect([entry?.stage, entry?.errorReason, entry?.action]).toEqual([
      "response",
      "AccessDenied",
      "continued",
    ]);
  });

  test("keeps Chrome's exact error when a command fails and still lets the request go", async () => {
    const { engine, sent, emit } = setup({ refused: { "Fetch.fulfillRequest": NOT_ALLOWED } });
    await armed(engine);
    emit(WORKER, "Fetch.requestPaused", paused());
    const [entry] = (await engine.journal()).paused;
    expect(on(sent, WORKER).at(-1)).toBe("Fetch.continueRequest");
    expect([entry?.action, entry?.declared, entry?.error]).toEqual([
      "continued",
      undefined,
      NOT_ALLOWED,
    ]);
  });

  test("wraps a body Chrome returns as text", async () => {
    const { engine, sent, emit } = setup({
      replies: { "Fetch.getResponseBody": { body: CLASSIC, base64Encoded: false } },
    });
    await armed(engine);
    emit(WORKER, "Fetch.requestPaused", paused());
    await engine.journal();
    expect(sent.at(-1)?.params).toMatchObject({ body: btoa(`${withMarker("m1")};\n${CLASSIC}`) });
  });
});
