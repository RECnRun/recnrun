import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/extension.ts";
import { recordedTabId } from "./fixtures/tabs.ts";

test.use({ remoteDebuggingPort: 9333 });

const manifestPath = fileURLToPath(
  new URL("../../apps/extension/.output/chrome-mv3-test/manifest.json", import.meta.url),
);

interface ChromeGlobal {
  chrome: { commands?: { getAll(): Promise<{ name?: string; shortcut?: string }[]> } } & Record<
    string,
    unknown
  >;
}

test("the toolbar icon does nothing", async ({
  context,
  page,
  serviceWorker,
  clickToolbarIcon,
}) => {
  await page.goto("/privacy/");
  const pages = context.pages().length;
  await clickToolbarIcon(page);

  // Give a handler, were there one, the time to open a tab, a window, or a session.
  await page.waitForTimeout(500);
  expect(context.pages()).toHaveLength(pages);
  expect(await recordedTabId(serviceWorker)).toBeNull();
});

test("the extension has no popup, keyboard commands, or context menu", async ({
  serviceWorker,
}) => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.action).toBeDefined();
  expect(manifest.action.default_popup).toBeUndefined();
  expect(manifest.commands).toBeUndefined();
  expect(manifest.permissions).toEqual(["storage", "tabs"]);

  const surface = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as ChromeGlobal;
    // Chrome leaves out the commands API when the manifest declares none.
    const commands = (await chrome.commands?.getAll()) ?? [];
    return { shortcuts: commands.filter((each) => each.shortcut), menus: "contextMenus" in chrome };
  });
  expect(surface).toEqual({ shortcuts: [], menus: false });
});
