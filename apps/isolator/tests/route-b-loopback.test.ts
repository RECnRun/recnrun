import { describe, expect, test } from "vite-plus/test";
import type { TargetInfo } from "@/background/probes/types";
import { RouteBEngine } from "@/background/route-b/engine";
import { fakeDebugger } from "./fake-debugger";
import { OUTSIDE, OUTSIDE_TAB, REFUSED, loopbackTab, withOutside } from "./outside-setup";

const APP = "http://app.localhost:4600";
const TAB = 7;
const ARM = { marker: "m1", urlPattern: "*/sw-*.js*" };

function setup(page: TargetInfo = loopbackTab(TAB, `${APP}/workers.html`)) {
  const fake = fakeDebugger({ targets: withOutside(page) });
  const engine = new RouteBEngine(
    () => fake.api,
    () => "chrome-extension://isolator/",
  );
  return { ...fake, engine, page };
}

/** A service worker script of the site outside the loopback, paused at the response stage. */
function pausedOutside() {
  return {
    requestId: "r-out",
    request: { url: `${OUTSIDE}/sw.js`, headers: { "Service-Worker": "script" } },
    resourceType: "Other",
    responseStatusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
  };
}

describe("Route B refuses targets outside the loopback (R11)", () => {
  test("arm refuses a tab outside the loopback before it attaches", async () => {
    const { engine, calls } = setup();
    await expect(engine.arm({ tabId: OUTSIDE_TAB, ...ARM })).rejects.toThrow(
      `refuses tab ${OUTSIDE_TAB} at ${OUTSIDE}/, which is not on the loopback`,
    );
    expect(calls).toEqual(["getTargets"]);
  });

  test("stopWorker refuses a worker outside the loopback before it attaches", async () => {
    const { engine, calls } = setup();
    await expect(engine.stopWorker({ targetId: "outside-sw" })).rejects.toThrow(
      `refuses target outside-sw at ${OUTSIDE}/sw.js, which is not on the loopback`,
    );
    expect(calls).toEqual(["getTargets"]);
  });

  test("update refuses an armed tab that navigated away from the loopback", async () => {
    const { engine, calls, page } = setup();
    await engine.arm({ tabId: TAB, ...ARM });
    page.url = `${OUTSIDE}/`;
    calls.length = 0;
    await expect(engine.update({ tabId: TAB })).rejects.toThrow(
      `refuses tab ${TAB} at ${OUTSIDE}/, which is not on the loopback`,
    );
    expect(calls).toEqual(["getTargets"]);
  });

  test("a worker outside the loopback gets no Fetch.enable or Network.enable, only its release", async () => {
    const { engine, sent, emit } = setup();
    await engine.arm({ tabId: TAB, ...ARM, network: true });
    emit({ tabId: TAB }, "Target.attachedToTarget", {
      sessionId: "s-out",
      waitingForDebugger: true,
      targetInfo: { targetId: "outside-sw", type: "service_worker", url: `${OUTSIDE}/sw.js` },
    });
    const { workers } = await engine.journal();
    const methods = sent.filter(({ target }) => target.sessionId === "s-out").map((s) => s.method);
    expect(methods).toEqual(["Runtime.runIfWaitingForDebugger"]);
    expect(workers).toMatchObject([
      { targetId: "outside-sw", fetchEnable: REFUSED, networkEnable: REFUSED, released: true },
    ]);
  });

  test("a paused script outside the loopback is only continued, never read or fulfilled", async () => {
    const { engine, sent, emit } = setup();
    await engine.arm({ tabId: TAB, ...ARM });
    sent.length = 0;
    emit({ tabId: TAB }, "Fetch.requestPaused", pausedOutside());
    const { paused } = await engine.journal();
    expect(sent.map(({ method, params }) => [method, params])).toEqual([
      ["Fetch.continueRequest", { requestId: "r-out" }],
    ]);
    expect(paused).toMatchObject([
      { url: `${OUTSIDE}/sw.js`, action: "continued", refused: REFUSED },
    ]);
    expect(paused[0]?.role).toBeUndefined();
  });
});
