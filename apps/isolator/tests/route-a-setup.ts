import { RouteAEngine } from "@/background/route-a/engine";
import type { TargetInfo } from "@/background/probes/types";
import { fakeDebugger } from "./fake-debugger";
import type { FakeOptions } from "./fake-debugger";

export const APP = "http://app.localhost:4600";
export const TAB = 7;
export const TARGETS: TargetInfo[] = [
  { type: "page", id: "page", url: `${APP}/workers.html?type=classic`, attached: true, tabId: TAB },
  { type: "other", id: "dedicated", url: `${APP}/worker.js?type=classic`, attached: true },
  { type: "worker", id: "shared", url: `${APP}/shared-worker.js?type=classic`, attached: false },
  { type: "worker", id: "elsewhere", url: "http://idp.localhost:4602/sw.js", attached: false },
];
// The bootstrap's answer at a waitForDebugger pause, where Cache Storage does not exist yet (E2).
export const INSTALLED = {
  marker: "m1",
  installedAt: 1,
  realmAgeMs: 2.5,
  patches: {
    fetch: { status: "installed", typeof: "function" },
    indexedDB: { status: "installed", typeof: "object" },
    caches: { status: "skipped", typeof: "undefined" },
  },
};

/** A Route A engine on a fake debugger whose clock advances 5 ms per reading. */
export function setup(options: FakeOptions = {}) {
  const fake = fakeDebugger({
    targets: TARGETS,
    ...options,
    replies: {
      "Runtime.evaluate": { result: { type: "object", value: INSTALLED } },
      ...options.replies,
    },
  });
  let clock = 0;
  const engine = new RouteAEngine(
    () => fake.api,
    () => (clock += 5),
  );
  engine.setMarker("m1");
  return { ...fake, engine };
}

export function attached(type: string, targetId: string, sessionId: string, waiting = true) {
  return {
    sessionId,
    waitingForDebugger: waiting,
    targetInfo: { targetId, type, url: `${APP}/${targetId}.js` },
  };
}

/** Commands sent on one flattened session, in order. */
export function on(sent: ReturnType<typeof fakeDebugger>["sent"], sessionId: string): string[] {
  return sent.filter((entry) => entry.target.sessionId === sessionId).map((entry) => entry.method);
}
