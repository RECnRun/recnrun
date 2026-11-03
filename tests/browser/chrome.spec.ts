import { existsSync, readFileSync } from "node:fs";
import { expect, launchChrome, test } from "./fixtures/chrome.ts";

// POC PLAN.md P0.2: the lab runs Google Chrome Stable 156 or later, never Chromium.
const MINIMUM_MAJOR = 156;
const VERSIONS_FILE = "/opt/recnrun/versions.json";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("connects to Google Chrome Stable 156 or later and reads Browser.getVersion", async ({
  chrome,
}, testInfo) => {
  testInfo.annotations.push({ type: "chrome", description: chrome.version });
  const installed = /^Google Chrome (\d+)\.\d+\.\d+\.\d+$/.exec(chrome.version);
  expect(installed, `Not Google Chrome: ${chrome.version}`).not.toBeNull();
  expect(Number(installed?.[1])).toBeGreaterThanOrEqual(MINIMUM_MAJOR);

  const { product, userAgent } = await chrome.cdp.send("Browser.getVersion");
  console.log(`${chrome.version}; Browser.getVersion product: ${product}`);
  expect(product).toBe(`Chrome/${chrome.version.slice("Google Chrome ".length)}`);
  expect(userAgent).not.toMatch(/HeadlessChrome|Chromium/);
  if (existsSync(VERSIONS_FILE)) {
    const versions = JSON.parse(readFileSync(VERSIONS_FILE, "utf8")) as { chrome: string };
    expect(versions.chrome).toBe(chrome.version);
  }
});

test("gives each launch its own root and removes it with the process on close", async () => {
  const first = await launchChrome();
  const second = await launchChrome();
  expect(second.userDataDir).not.toBe(first.userDataDir);

  await first.close();
  await second.close();
  for (const chrome of [first, second]) {
    expect(chrome.browser.isConnected()).toBe(false);
    expect(isRunning(chrome.pid)).toBe(false);
    expect(existsSync(chrome.userDataDir)).toBe(false);
  }
});
