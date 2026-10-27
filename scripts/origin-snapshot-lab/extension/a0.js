// Candidate A0, the negative control: the restore runs at document_start in the application's
// own document, asynchronously, while the application's scripts run.
(() => {
  const nonce = new URLSearchParams(location.search).get("__recnrun_a0");
  if (!nonce) return;
  const lab = self.__originLab;
  const report = (step, extra = {}) => chrome.runtime.sendMessage({ a0: step, nonce, ...extra });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    const plan = await report("ready");
    if (!plan?.ok) return;
    await pause(plan.delayMs);
    const cleared = await lab.clearAll(plan.clear);
    const restored = await lab.restoreAll(plan.target, plan.clear);
    await report("done", { cleared, restored: restored.ms });
  }

  run().catch((error) => report("failed", { error: String(error?.message ?? error) }));
})();
