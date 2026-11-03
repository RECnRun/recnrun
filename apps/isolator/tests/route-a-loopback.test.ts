import { describe, expect, test } from "vite-plus/test";
import { OUTSIDE, OUTSIDE_TAB, REFUSED, loopbackTab, withOutside } from "./outside-setup";
import { APP, TAB, attached, on, setup } from "./route-a-setup";

const tab = () => loopbackTab(TAB, `${APP}/workers.html`);
const targets = (page = tab()) => withOutside(page);

function outsideChild(targetId: string, sessionId: string, waiting = true) {
  const event = attached("worker", targetId, sessionId, waiting);
  return { ...event, targetInfo: { ...event.targetInfo, url: `${OUTSIDE}/worker.js` } };
}

describe("Route A refuses targets outside the loopback (R11)", () => {
  test("arm refuses a tab outside the loopback before it attaches", async () => {
    const { engine, calls } = setup({ targets: targets() });
    await expect(engine.arm({ tabId: OUTSIDE_TAB })).rejects.toThrow(
      `refuses tab ${OUTSIDE_TAB} at ${OUTSIDE}/, which is not on the loopback`,
    );
    expect(calls).toEqual(["getTargets"]);
  });

  test("arm accepts a tab still at about:blank, which has no origin yet", async () => {
    const { engine, calls } = setup({
      targets: targets(loopbackTab(TAB, "about:blank#recnrun-e3")),
    });
    await engine.arm({ tabId: TAB });
    expect(calls.slice(0, 2)).toEqual(["getTargets", "attach"]);
  });

  test.each(["attachTarget", "closeTarget"] as const)(
    "%s refuses a worker outside the loopback before it attaches",
    async (method) => {
      const { engine, calls } = setup({ targets: targets() });
      await expect(engine[method]({ targetId: "outside-sw" })).rejects.toThrow(
        `refuses target outside-sw at ${OUTSIDE}/sw.js, which is not on the loopback`,
      );
      expect(calls).toEqual(["getTargets"]);
    },
  );

  test.each([false, true])(
    "releases untouched a child outside the loopback once the armed tab left it (pauseBeforeScript %s)",
    async (pauseBeforeScript) => {
      const page = tab();
      const { engine, sent, emit } = setup({ targets: targets(page) });
      await engine.arm({ tabId: TAB, pauseBeforeScript });
      // The armed tab navigates to a site outside the loopback, whose workers then attach.
      page.url = `${OUTSIDE}/`;
      emit({ tabId: TAB }, "Target.attachedToTarget", outsideChild("out", "s-out"));
      emit({ tabId: TAB }, "Target.attachedToTarget", outsideChild("running", "s-run", false));
      const { entries } = await engine.journal();
      expect(on(sent, "s-out")).toEqual(["Runtime.runIfWaitingForDebugger"]);
      expect(on(sent, "s-run")).toEqual([]);
      const seen = entries.map(({ targetId, marker, released, error }) => ({
        targetId,
        marker,
        released,
        error,
      }));
      expect(seen).toEqual([
        { targetId: "out", marker: undefined, released: true, error: REFUSED },
        { targetId: "running", marker: undefined, released: false, error: REFUSED },
      ]);
    },
  );
});
