import { describe, expect, test } from "vite-plus/test";
import { runAllProbes } from "@/background/probes/runner";
import type { ProbeResult } from "@/background/probes/types";
import { byId, fakeDebugger, noWait, URLS } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

async function probe(id: string, options: FakeOptions): Promise<ProbeResult | undefined> {
  const { api } = fakeDebugger(options);
  return byId(await runAllProbes(api, URLS, noWait))[id];
}

/** A command Chrome accepted without its effect is `rejected` with what did not happen. */
describe("a probe whose effect did not happen", () => {
  test.each<[string, FakeOptions, string]>([
    [
      "network-set-cookie",
      { replies: { "Network.setCookie": { success: false } } },
      "Network.setCookie returned success=false",
    ],
    [
      "worker-debugger-pause",
      { muted: ["Debugger.paused"] },
      "Debugger.pause accepted but no Debugger.paused event within 2000 ms",
    ],
    [
      "worker-close-target",
      { replies: { "Target.closeTarget": { success: false } } },
      "Target.closeTarget returned success=false",
    ],
    [
      "worker-close-target",
      { keepsClosed: true },
      "worker still listed by getTargets() 500 ms after Target.closeTarget",
    ],
    [
      "auto-attach",
      { muted: ["Target.attachedToTarget"] },
      "Target.setAutoAttach accepted but no Target.attachedToTarget within 5000 ms of the reload and the iframe",
    ],
    [
      "run-if-waiting-for-debugger",
      { hanging: ["Runtime.runIfWaitingForDebugger"] },
      "Runtime.runIfWaitingForDebugger got no reply for the worker within 5000 ms",
    ],
    [
      "worker-runtime-evaluate",
      { replies: { "Runtime.evaluate": { exceptionDetails: { text: "Uncaught" } } } },
      "Runtime.evaluate threw: Uncaught",
    ],
    [
      "tab-target-get-targets",
      { replies: { "Target.getTargets": {} } },
      "Target.getTargets returned no targetInfos",
    ],
    [
      "tab-attach-to-service-worker",
      { replies: { "Target.attachToTarget": {} } },
      "Target.attachToTarget returned no sessionId",
    ],
    [
      "storage-get-cookies",
      { replies: { "Storage.getCookies": {} } },
      "Storage.getCookies returned no cookies array",
    ],
    [
      "page-add-script-on-new-document",
      { replies: { "Page.addScriptToEvaluateOnNewDocument": {} } },
      "Page.addScriptToEvaluateOnNewDocument returned no identifier",
    ],
    ["cleanup", { detachError: "Debugger is not attached" }, "Debugger is not attached"],
  ])("%s is rejected (case %#)", async (id, options, error) => {
    expect(await probe(id, options)).toMatchObject({ id, status: "rejected", error });
  });

  test("an accepted pause records that the event arrived", async () => {
    expect(await probe("worker-debugger-pause", {})).toMatchObject({
      status: "allowed",
      detail: { pausedEventArrived: true },
    });
  });

  test("a pause that never arrives skips Debugger.resume, which Chrome refuses when not paused", async () => {
    const { api, sent } = fakeDebugger({ muted: ["Debugger.paused"] });
    await runAllProbes(api, URLS, noWait);
    expect(sent.map(({ method }) => method)).not.toContain("Debugger.resume");
  });
});
