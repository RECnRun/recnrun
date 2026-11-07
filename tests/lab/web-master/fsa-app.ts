import type { Page } from "@playwright/test";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import { waitReady } from "./fsa-harness.ts";

/*
 * The installed-app variant of W.fsa: CDP's PWA domain stands in for the omnibox install button,
 * and Chrome's own internals pages report the install state and the discard protection.
 */

/**
 * Sends a PWA command on the browser target over `--remote-debugging-pipe`: Chrome registers the
 * PWA domain only for a client that allows unsafe operations, which the pipe does and the port
 * does not (chrome_devtools_session.cc, devtools_pipe_handler.cc).
 */
async function pwa(master: LaunchedChrome, method: string, params: Record<string, unknown>) {
  if (!master.pipe) throw new Error("The app variant's master Chrome needs the CDP pipe.");
  return master.pipe.send<Record<string, unknown>>(method, params);
}

const manifestIdOf = (origin: string) => `${origin}/`;

export async function install(master: LaunchedChrome, origin: string) {
  // From the browser target, Chrome installs from a URL it loads itself.
  await pwa(master, "PWA.install", {
    manifestId: manifestIdOf(origin),
    installUrlOrBundleUrl: `${origin}/`,
  });
  // A DevTools install opens in a tab; the omnibox install opens in its own window.
  await pwa(master, "PWA.changeAppUserSettings", {
    manifestId: manifestIdOf(origin),
    displayMode: "standalone",
  });
}

export async function uninstall(master: LaunchedChrome, origin: string) {
  return pwa(master, "PWA.uninstall", { manifestId: manifestIdOf(origin) });
}

/** Launches the installed app the way its shortcut would, and returns its window's page. */
export async function launchApp(master: LaunchedChrome, origin: string) {
  const pages = () => master.browser.contexts().flatMap((context) => context.pages());
  const before = pages().filter((each) => each.url().startsWith(origin));
  if (before.length > 0) throw new Error("A page of the stand-in is still open before the launch.");
  await pwa(master, "PWA.launch", { manifestId: manifestIdOf(origin) });
  // Chrome may move a blank tab into the app window, so any page of the stand-in is the app's.
  for (let tries = 150; tries > 0; tries--) {
    const page = pages().find((each) => each.url().startsWith(origin));
    if (page) {
      await waitReady(page);
      const standalone = await page.evaluate(
        () => matchMedia("(display-mode: standalone)").matches,
      );
      return { page, standalone };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The launched app window never showed a page of the stand-in.");
}

/** Every text node of a page, shadow roots included (the internals pages are web components). */
const deepText = (page: Page) =>
  page.evaluate(() => {
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
      const shadow = node instanceof Element ? node.shadowRoot : null;
      if (shadow) walk(shadow);
      for (const child of node.childNodes) walk(child);
    };
    walk(document.body);
    return parts.join(" ").replaceAll(/\s+/g, " ");
  });

async function internals(master: LaunchedChrome, url: string): Promise<string> {
  const context = master.browser.contexts()[0];
  if (!context) throw new Error("The master Chrome has no default context.");
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForTimeout(2_000);
    return await deepText(page);
  } finally {
    await page.close();
  }
}

const around = (text: string, needle: string, span = 400) => {
  const at = text.indexOf(needle);
  return at < 0 ? "" : text.slice(Math.max(0, at - span), at + span);
};

/** The one app record of the internals dump whose manifest id is the lab's. */
function appRecord(text: string, manifestId: string): string {
  const at = text.indexOf(`"manifest_id": "${manifestId}"`);
  if (at < 0) return "";
  const start = text.lastIndexOf('"!app_id"', at);
  const end = text.indexOf('"!app_id"', at);
  return text.slice(Math.max(0, start), end < 0 ? undefined : end);
}

// The InstallState enum of chrome/browser/web_applications/proto/web_app_install_state.proto.
const INSTALL_STATES = [
  "SUGGESTED_FROM_ANOTHER_DEVICE",
  "INSTALLED_WITH_OS_INTEGRATION",
  "INSTALLED_WITHOUT_OS_INTEGRATION",
];

/** The lab app's install state in chrome://web-app-internals, by name, with the text around it. */
export async function installState(master: LaunchedChrome, origin: string) {
  const text = await internals(master, "chrome://web-app-internals");
  const excerpt = appRecord(text, manifestIdOf(origin));
  const code = /"install_state": "(\d)"/.exec(excerpt)?.[1];
  const state = code === undefined ? "not listed" : (INSTALL_STATES[Number(code)] ?? code);
  return { state, excerpt };
}

/** Turns on Chrome's internal debugging pages (chrome://discards among them) as a person would. */
async function enableDebugPages(master: LaunchedChrome): Promise<void> {
  const page = await master.browser.contexts()[0]?.newPage();
  if (!page) throw new Error("The master Chrome has no default context.");
  try {
    await page.goto("chrome://chrome-urls");
    const enable = page.getByRole("button", { name: /enable/i });
    if (await enable.isVisible()) await enable.click();
  } finally {
    await page.close();
  }
}

/** What chrome://discards says of the lab's page, its protection reason among it. */
export async function discards(master: LaunchedChrome): Promise<string> {
  await enableDebugPages(master);
  const text = await internals(master, "chrome://discards");
  return around(text, "recnrun.test") || text.slice(0, 2_000);
}
