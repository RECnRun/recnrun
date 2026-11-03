import { expect, loadExtension, test } from "./fixtures/extension.ts";

// The isolator's chrome.storage.session marker (apps/isolator/src/background/start.ts).
const LOADED_KEY = "isolatorLoaded";

test("loads the isolator into Google Chrome and its background answers", async ({
  extension,
}, testInfo) => {
  const method = [extension.method, extension.label].filter(Boolean).join(", ");
  testInfo.annotations.push({ type: "extension-load", description: method });
  console.log(`${extension.chrome.version}; loaded with ${method}`);
  expect(extension.extensionId).toMatch(/^[a-p]{32}$/);
  const self = (await extension.evaluateInBackground("chrome.management.getSelf()")) as {
    id: string;
    name: string;
  };
  expect(self.id).toBe(extension.extensionId);
  expect(self.name).toBe("RECnRun Isolator (POC)");
  await expect
    .poll(() => extension.evaluateInBackground(`chrome.storage.session.get("${LOADED_KEY}")`))
    .toMatchObject({ [LOADED_KEY]: { loaded: true, id: extension.extensionId } });
  expect(extension.chrome.browser.isConnected()).toBe(true);
});

test("fails with the remedy when no method loads the extension", async () => {
  const refuse = async (): Promise<never> => {
    throw new Error("refused");
  };
  await expect(loadExtension(undefined, [refuse, refuse])).rejects.toThrow(
    /^Google Chrome \S+ accepted no extension-loading method; see docs\/poc\/namespace-sessions\/experiments\/E0\.md and MANUAL_VALIDATION\.md M-P0\.a\.\nrefused\nrefused$/,
  );
});
