import { existsSync } from "node:fs";
import { expect, launchChrome, test } from "./fixtures/chrome.ts";

const MINIMUM_MAJOR = 144;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("connects to Google Chrome Stable and reads Browser.getVersion", async ({
  chrome,
}, testInfo) => {
  testInfo.annotations.push({ type: "chrome", description: chrome.version });
  const installed = /^Google Chrome (\d+)\.\d+\.\d+\.\d+$/.exec(chrome.version);
  expect(installed, `Not Google Chrome: ${chrome.version}`).not.toBeNull();

  const { product } = await chrome.cdp.send("Browser.getVersion");
  console.log(`${chrome.version}; Browser.getVersion product: ${product}`);
  expect(product).toBe(`Chrome/${chrome.version.slice("Google Chrome ".length)}`);
  expect(Number(installed?.[1])).toBeGreaterThanOrEqual(MINIMUM_MAJOR);
  expect(chrome.browser.isConnected()).toBe(true);
});

test("gives each launch its own profile and removes it with the process on close", async () => {
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
