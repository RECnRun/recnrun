// The gate document (candidates A1, A2, A3): a normal navigation to the app's URL with a one-time
// marker. At document_start, before the parser reaches any page script, A1 and A3 halt the
// document; A2 relies on the CSP header a DNR rule added. Then the origin's storage is captured,
// persisted by the background, cleared, and restored here, and the background navigates on.
(() => {
  const marker = new URLSearchParams(location.search).get("__recnrun_gate");
  if (!marker) return;
  const [nonce, mode] = marker.split(".");
  if (mode !== "a2") {
    window.stop();
    document.documentElement.replaceChildren();
  }
  // A parked companion tab (Experiment E) stays halted until the lead's switch reloads it.
  if (mode === "park") return;
  const lab = self.__originLab;
  const report = (step, extra = {}) => chrome.runtime.sendMessage({ gate: step, nonce, ...extra });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Reports a step the background must accept before the page goes on. */
  const accepted = async (step, extra) => {
    const ack = await report(step, extra);
    if (!ack?.ok) throw new Error(ack?.error ?? `the ${step} step was refused`);
    return ack;
  };

  async function run() {
    const plan = await report("ready", {
      href: location.href,
      topLevel: window === window.top,
      scripts: document.scripts.length,
    });
    if (!plan?.ok) return;
    const captured = await lab.captureAll();
    const { target } = await accepted("captured", { captured });
    await pause(plan.delayMs);
    if (plan.clear.probe) await lab.probeAll(plan.clear);
    // Up to here nothing changed: the background may still take the tabs back.
    await accepted("clearing");
    const cleared = await lab.clearAll(plan.clear);
    await accepted("cleared");
    const restored = await lab.restoreAll(target, plan.clear);
    await report("done", { cleared, restored: restored.ms, captureMs: captured.ms });
  }

  run().catch((error) => report("failed", { error: String(error?.message ?? error) }));
})();
