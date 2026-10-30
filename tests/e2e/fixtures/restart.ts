import { chromium } from "@playwright/test";
import { expect } from "./extension.ts";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

/**
 * Stops the extension's service worker through the DevTools port, as Chrome stops it on its own.
 * chrome.runtime.reload() unloads the command-line extension for good in this Chromium, so the
 * worker is stopped instead: either way its memory is gone and a new worker starts.
 */
export async function stopWorker(port: number): Promise<void> {
  const remote = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const cdp = await remote.newBrowserCDPSession();
  const workers = async () =>
    ((await cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] }).targetInfos.filter(
      ({ type, url }) => type === "service_worker" && url.startsWith("chrome-extension://"),
    );
  for (const { targetId } of await workers()) await cdp.send("Target.closeTarget", { targetId });
  await expect.poll(async () => (await workers()).length).toBe(0);
  await remote.close();
}
