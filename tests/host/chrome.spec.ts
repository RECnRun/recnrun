import { existsSync } from "node:fs";
import { expect, GESTURE_TIMEOUT_MS, openHostExtension, test } from "./fixtures/host-chrome.ts";
import { CHROME_BINARY, installedChromeVersion } from "./fixtures/host-env.ts";

// POC PLAN.md P0.5: the installed Google Chrome of this Mac, on throwaway roots only.
const EXTENSION_ID = /^[a-p]{32}$/;
const DEBUGGING = /^--(remote-debugging-|enable-unsafe-extension-debugging)/;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("connects to the installed Google Chrome, whose Browser.getVersion matches its Info.plist", async ({
  hostExtension,
}) => {
  const installed = await installedChromeVersion();
  const { chrome } = hostExtension;
  const { product, userAgent } = await chrome.cdp.send("Browser.getVersion");
  console.log(`${chrome.version}; Browser.getVersion product: ${product}`);
  expect(chrome.executable).toBe(CHROME_BINARY);
  expect(chrome.version).toBe(`Google Chrome ${installed}`);
  expect(product).toBe(`Chrome/${installed}`);
  expect(userAgent).not.toMatch(/HeadlessChrome|Chromium/);
  const versions = (await hostExtension.evidence.read("versions.json")) as { product: string };
  expect(versions.product).toBe(product);
});

test("installs the test build with Extensions.loadUnpacked and its service worker answers", async ({
  hostExtension,
}) => {
  expect(hostExtension.method).toBe("loadUnpacked");
  expect(hostExtension.extensionId).toMatch(EXTENSION_ID);
  const answered = await hostExtension.evaluateInBackground("chrome.runtime.id");
  expect(answered).toBe(hostExtension.extensionId);
  const { chrome, extensionId, label, method } = hostExtension;
  await hostExtension.evidence.write("install-diagnostic.json", {
    environment: "host",
    chrome: chrome.version,
    install: method,
    label,
    extensionId,
    answered,
    flags: chrome.flags.filter((flag) => !flag.startsWith("--user-data-dir=")),
  });
});

test("stops only the Chrome each launch spawned and removes its root", async () => {
  const { testId } = test.info();
  const first = await openHostExtension(`close-${testId}-a`);
  const second = await openHostExtension(`close-${testId}-b`).catch(async (error: unknown) => {
    await first.close();
    throw error;
  });
  expect(second.root).not.toBe(first.root);
  expect(second.chrome.pid).not.toBe(first.chrome.pid);
  await first.close();
  expect(isRunning(first.chrome.pid)).toBe(false);
  expect(isRunning(second.chrome.pid)).toBe(true);
  await second.close();
  for (const launched of [first, second]) {
    expect(isRunning(launched.chrome.pid)).toBe(false);
    expect(existsSync(launched.root)).toBe(process.env.RECNRUN_HOST_KEEP_ROOTS === "1");
  }
});

test.describe("strict: the owner's Load unpacked", () => {
  test.skip(
    process.env.RECNRUN_HOST_GESTURE !== "1",
    "Needs the owner's Load unpacked gesture in the window it opens; set RECNRUN_HOST_GESTURE=1.",
  );
  test.describe.configure({ timeout: GESTURE_TIMEOUT_MS + 60_000 });

  test("installs the build with no debugging flag on the root", async ({ hostStrict }) => {
    expect(hostStrict.extensionId).toMatch(EXTENSION_ID);
    expect(hostStrict.chrome.flags.filter((flag) => DEBUGGING.test(flag))).toEqual([]);
    await hostStrict.evidence.write("install-strict.json", {
      environment: "host",
      chrome: hostStrict.chrome.version,
      install: hostStrict.method,
      label: hostStrict.label,
      extensionId: hostStrict.extensionId,
    });
  });
});
