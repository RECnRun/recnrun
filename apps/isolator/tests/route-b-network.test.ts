import { describe, expect, test } from "vite-plus/test";
import type { Debuggee } from "@/background/probes/types";
import { RouteBEngine } from "@/background/route-b/engine";
import { fakeDebugger, NOT_ALLOWED } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

const TAB = 7;
const WORKER: Debuggee = { tabId: TAB, sessionId: "s-sw" };
const ME = "http://api.localhost:4601/me?from=%2Fsw-main.js";
const WORKER_ATTACHED = {
  sessionId: "s-sw",
  waitingForDebugger: true,
  targetInfo: { targetId: "sw", type: "service_worker", url: "http://app.localhost:4600/sw.js" },
};

async function armedWorker(options: FakeOptions, network: boolean) {
  const fake = fakeDebugger(options);
  const engine = new RouteBEngine(
    () => fake.api,
    () => "chrome-extension://isolator/",
  );
  await engine.arm({ tabId: TAB, marker: "m1", urlPattern: "*/sw-*.js*", network });
  fake.emit({ tabId: TAB }, "Target.attachedToTarget", WORKER_ATTACHED);
  return { ...fake, engine };
}

function blockedRequest(emit: ReturnType<typeof fakeDebugger>["emit"]) {
  emit(WORKER, "Network.requestWillBeSent", { requestId: "n1", request: { url: ME } });
  emit(WORKER, "Network.requestWillBeSentExtraInfo", {
    requestId: "n1",
    headers: {},
    clientSecurityState: {
      initiatorIsSecureContext: false,
      initiatorIPAddressSpace: "Unknown",
      localNetworkAccessRequestPolicy: "PermissionBlock",
    },
  });
  emit(WORKER, "Network.loadingFailed", {
    requestId: "n1",
    errorText: "net::ERR_FAILED",
    blockedReason: "local-network-access",
    corsErrorStatus: { corsError: "LocalNetworkAccessPermissionDenied", failedParameter: "" },
  });
}

describe("Route B network diagnostics", () => {
  test("sends Network.enable before release without waiting for its held reply", async () => {
    const held = { heldUntil: { "Network.enable": "Runtime.runIfWaitingForDebugger" } };
    const { engine, sent, emit } = await armedWorker(held, true);
    blockedRequest(emit);
    const { workers, network } = await engine.journal();
    expect(sent.filter((entry) => entry.target.sessionId === "s-sw").map((e) => e.method)).toEqual([
      "Fetch.enable",
      "Network.enable",
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(workers[0]?.networkEnable).toBe("ok");
    expect(network).toEqual([
      {
        sessionId: "s-sw",
        requestId: "n1",
        url: ME,
        initiatorIPAddressSpace: "Unknown",
        requestPolicy: "PermissionBlock",
        errorText: "net::ERR_FAILED",
        blockedReason: "local-network-access",
        corsError: "LocalNetworkAccessPermissionDenied",
      },
    ]);
  });

  test("keeps Chrome's error for Network.enable and ignores Network events unless asked", async () => {
    const refused = await armedWorker({ refused: { "Network.enable": NOT_ALLOWED } }, true);
    const [worker] = (await refused.engine.journal()).workers;
    expect([worker?.networkEnable, worker?.released]).toEqual([NOT_ALLOWED, true]);
    const quiet = await armedWorker({}, false);
    blockedRequest(quiet.emit);
    const journal = await quiet.engine.journal();
    expect(quiet.sent.map((entry) => entry.method)).not.toContain("Network.enable");
    expect([journal.workers[0]?.networkEnable, journal.network]).toEqual(["skipped", []]);
  });

  test("ignores the tab's own requests and malformed events", async () => {
    const { engine, emit } = await armedWorker({}, true);
    emit({ tabId: TAB }, "Network.loadingFailed", {
      requestId: "t1",
      errorText: "net::ERR_FAILED",
    });
    emit(WORKER, "Network.loadingFailed", { requestId: 3 });
    expect((await engine.journal()).network).toEqual([]);
  });
});
