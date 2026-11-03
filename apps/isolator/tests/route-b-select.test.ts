import { runInNewContext } from "node:vm";
import { BOOTSTRAP_SOURCE, withMarker } from "@recnrun/worker-bootstrap";
import { describe, expect, test } from "vite-plus/test";
import type { Debuggee } from "@/background/probes/types";
import { RouteBEngine } from "@/background/route-b/engine";
import { selectionWrapper } from "@/background/route-b/select";
import { fakeDebugger } from "./fake-debugger";

// E6 (POC PLAN.md P1.5): wrappers that select the session when the worker starts, never by name.
const APP = "http://app.localhost:4600";
const TAB = 7;
const WORKER: Debuggee = { tabId: TAB, sessionId: "s-w" };
const EXTENSION = "chrome-extension://isolator/";
const BODY = "fetch('/me');\n";
const NOT_FOUND = '{"error":"Not found"}';

function setup(body = BODY) {
  const fake = fakeDebugger({
    replies: { "Fetch.getResponseBody": { body: btoa(body), base64Encoded: true } },
  });
  let clock = 0;
  const engine = new RouteBEngine(
    () => fake.api,
    () => EXTENSION,
    () => (clock += 5),
  );
  return { ...fake, engine };
}

function arm(engine: RouteBEngine, selection: string, urlPattern = "*/sw-*.js*") {
  return engine.arm({ tabId: TAB, marker: "slot-3", urlPattern, selection });
}

function paused(url: string, { main = true, status = 200, type = "text/javascript" } = {}) {
  return {
    requestId: "r1",
    request: { url, headers: main ? { "Service-Worker": "script" } : {} },
    resourceType: main ? "Other" : "Script",
    responseStatusCode: status,
    responseStatusText: status === 200 ? "OK" : "Not Found",
    responseHeaders: [{ name: "Content-Type", value: type }],
  };
}

function bodyOf(sent: ReturnType<typeof fakeDebugger>["sent"]): string {
  const params = sent.at(-1)?.params;
  return atob(String(params && Reflect.get(params, "body")));
}

describe("selectionWrapper", () => {
  test("imports the slot and the page bootstrap from the extension, naming no session", () => {
    const wrapped = selectionWrapper("extension-import", BODY, EXTENSION);
    expect(wrapped).toBe(
      `importScripts("${EXTENSION}ns/current.js", "${EXTENSION}route-c.js");\n${BODY}`,
    );
    expect(selectionWrapper("app-import", BODY, EXTENSION)).toBe(
      `importScripts("/recnrun/current.js", "${EXTENSION}route-c.js");\n${BODY}`,
    );
    expect(selectionWrapper("fetch-import", BODY, EXTENSION)).toBe(
      `importScripts("/recnrun/fetched.js");\n${BODY}`,
    );
  });

  test("reads the slot with a synchronous XHR and installs the bootstrap it names", () => {
    const wrapped = selectionWrapper("sync-xhr", BODY, EXTENSION);
    expect(wrapped.endsWith(`\n${BODY}`)).toBe(true);
    expect(wrapped).toContain('request.open("GET", "/recnrun/current.js", false);');
    expect(wrapped).toContain(BOOTSTRAP_SOURCE);
    expect(wrapped).not.toContain("slot-");
  });

  test("the synchronous XHR wrapper installs the marker of the slot file it receives", () => {
    const wrapped = selectionWrapper("sync-xhr", "", EXTENSION);
    const run = (responseText: string) => {
      const scope = { installed: undefined as unknown };
      const source = wrapped.replace(
        BOOTSTRAP_SOURCE,
        "((options) => (scope.installed = options))",
      );
      const xhr = class {
        responseText = responseText;
        open() {}
        send() {}
      };
      runInNewContext(source, { XMLHttpRequest: xhr, scope });
      return scope.installed;
    };
    expect(run('globalThis.__recnrunMarker = "slot-4";\n')).toEqual({ marker: "slot-4" });
    // An unredirected request gets the fixture's 404 body, and an empty marker fails closed.
    expect(run(NOT_FOUND)).toEqual({ marker: "" });
  });
});

describe("Route B selection", () => {
  test("fetch-import also intercepts the selection path and fulfills it with the armed marker", async () => {
    const { engine, sent, emit } = setup();
    await arm(engine, "fetch-import");
    expect(sent[0]?.params).toEqual({
      patterns: [
        { urlPattern: "*/sw-*.js*", requestStage: "Response" },
        { urlPattern: "*/recnrun/fetched.js*", requestStage: "Response" },
      ],
    });
    emit(
      WORKER,
      "Fetch.requestPaused",
      paused(`${APP}/recnrun/fetched.js`, { main: false, status: 404, type: "application/json" }),
    );
    const [entry] = (await engine.journal()).paused;
    expect(sent.at(-1)?.method).toBe("Fetch.fulfillRequest");
    expect(sent.at(-1)?.params).toMatchObject({
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
    });
    expect(bodyOf(sent)).toBe(`${withMarker("slot-3")};\n`);
    expect(entry).toMatchObject({ role: "selection", action: "fulfilled", status: 404 });
    expect(entry?.declared).toBeUndefined();
  });

  test("wraps a service worker's main script with the selection, not the bootstrap", async () => {
    const { engine, sent, emit } = setup();
    await arm(engine, "fetch-import");
    emit(WORKER, "Fetch.requestPaused", paused(`${APP}/sw-main.js`));
    const [entry] = (await engine.journal()).paused;
    expect(bodyOf(sent)).toBe(`importScripts("/recnrun/fetched.js");\n${BODY}`);
    expect(entry).toMatchObject({ role: "main", declared: "transformed", wrapper: "fetch-import" });
  });

  test("without fetch-import the selection path is let through like any request", async () => {
    const { engine, sent, emit } = setup();
    await arm(engine, "extension-import");
    expect(sent[0]?.params).toEqual({
      patterns: [{ urlPattern: "*/sw-*.js*", requestStage: "Response" }],
    });
    emit(WORKER, "Fetch.requestPaused", paused(`${APP}/recnrun/fetched.js`, { main: false }));
    await engine.journal();
    expect(sent.at(-1)?.method).toBe("Fetch.continueRequest");
  });

  test("sync-xhr wraps a dedicated worker's script, which carries no Service-Worker header", async () => {
    const { engine, sent, emit } = setup();
    await arm(engine, "sync-xhr", "*/*worker.js*");
    emit(WORKER, "Fetch.requestPaused", paused(`${APP}/worker.js?type=classic`, { main: false }));
    emit({ tabId: TAB }, "Fetch.requestPaused", paused(`${APP}/page.js`, { main: false }));
    const [worker, page] = (await engine.journal()).paused;
    expect(worker).toMatchObject({
      role: "imported",
      declared: "transformed",
      wrapper: "sync-xhr",
    });
    expect([page?.session, page?.action]).toEqual(["tab", "continued"]);
    expect(sent.filter((entry) => entry.method === "Fetch.fulfillRequest")).toHaveLength(1);
  });

  test("refuses a selection it does not know", async () => {
    const { engine } = setup();
    await expect(arm(engine, "dns")).rejects.toThrow(/expected \{ tabId, marker, urlPattern \}/);
  });
});
