import { setTimeout as delay } from "node:timers/promises";
import { openPage } from "../browser/fixtures/cdp-client.ts";
import type { CdpClient, PageSession } from "../browser/fixtures/cdp-client.ts";
import { clickAt } from "../browser/fixtures/x-display.ts";

/*
 * The switches of chrome://extensions/?id=<id>, clicked as a person would (E1, POC PLAN.md P1.2),
 * and the extension's state as that page reads it through chrome.developerPrivate.
 */

/** How a switch was clicked: a pointer on the display, CDP input on the page, or a DOM click. */
export type ToggleMethod = "xdotool" | "cdp-click" | "element-click";

const POLL_MS = 250;
const FLIP_TIMEOUT_MS = 5_000;
const FIND_TIMEOUT_MS = 15_000;

const MANAGER = "document.querySelector('extensions-manager')?.shadowRoot";
// Chrome 156 names the file row #allow-on-file-urls; Developer mode is the toolbar's #devMode.
const ROWS = {
  fileAccess: `${MANAGER}?.querySelector('extensions-detail-view')?.shadowRoot?.querySelector('#allow-on-file-urls')`,
  developerMode: `${MANAGER}?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode')`,
};
export type Switch = keyof typeof ROWS;

// A toggle row wraps a cr-toggle; Developer mode is the cr-toggle itself.
const toggleOf = (name: Switch) =>
  `(${ROWS[name]}?.shadowRoot?.querySelector('#crToggle') ?? ${ROWS[name]})`;

interface Spot {
  /** Viewport coordinates of the toggle's centre, in CSS pixels. */
  x: number;
  y: number;
  /** Where the viewport sits on the display: the window's position plus its frame and toolbar. */
  left: number;
  top: number;
  checked: boolean;
}

const spotOf = (name: Switch) => `(() => {
  const toggle = ${toggleOf(name)};
  if (!toggle || toggle.hidden) return null;
  toggle.scrollIntoView({ block: "center" });
  const rect = toggle.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    left: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    top: window.screenY + window.outerHeight - window.innerHeight,
    checked: Boolean(${ROWS[name]}.checked),
  };
})()`;

async function findSpot(page: PageSession, name: Switch): Promise<Spot> {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const spot = (await page.evaluate(spotOf(name))) as Spot | null;
    if (spot) return spot;
    if (Date.now() > deadline) throw new Error(`No visible ${name} switch on chrome://extensions`);
    await delay(POLL_MS);
  }
}

async function cdpClick(page: PageSession, { x, y }: Spot): Promise<void> {
  const at = { x, y, button: "left", clickCount: 1 };
  await page.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page.sessionId);
  await page.client.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", ...at },
    page.sessionId,
  );
  await page.client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", ...at },
    page.sessionId,
  );
}

async function click(page: PageSession, name: Switch, method: ToggleMethod): Promise<void> {
  const spot = await findSpot(page, name);
  if (method === "xdotool") return clickAt(spot.left + spot.x, spot.top + spot.y);
  if (method === "cdp-click") return cdpClick(page, spot);
  await page.evaluate(`${toggleOf(name)}.click()`);
}

async function flipped(page: PageSession, name: Switch, target: boolean): Promise<boolean> {
  const deadline = Date.now() + FLIP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await page.evaluate(`Boolean(${ROWS[name]}?.checked)`)) === target) return true;
    await delay(POLL_MS);
  }
  return false;
}

const settingsPage = (client: CdpClient, extensionId: string) =>
  openPage(client, `chrome://extensions/?id=${extensionId}`);

/**
 * Turns `name` to `target` with the first of `methods` that flips it. Returns no method when the
 * switch already was there (no gesture), and the methods that clicked without flipping it.
 */
export async function toggleSwitch(
  client: CdpClient,
  extensionId: string,
  { name, target }: { name: Switch; target: boolean },
  methods: readonly ToggleMethod[],
): Promise<{ method?: ToggleMethod; missed: ToggleMethod[] }> {
  const page = await settingsPage(client, extensionId);
  const missed: ToggleMethod[] = [];
  try {
    if ((await findSpot(page, name)).checked === target) return { missed };
    for (const method of methods) {
      await click(page, name, method);
      if (await flipped(page, name, target)) return { method, missed };
      missed.push(method);
    }
  } finally {
    await page.close();
  }
  throw new Error(`No click flipped ${name} to ${String(target)}: ${missed.join(", ")}`);
}

/** The extension's state, disable reasons that hold, and file access, as chrome://extensions sees them. */
export async function extensionState(client: CdpClient, extensionId: string): Promise<unknown> {
  const page = await settingsPage(client, extensionId);
  try {
    return await page.evaluate(`chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extensionId)}).then(
      ({ state, location, disableReasons, fileAccess }) => ({
        state, location, fileAccess,
        disableReasons: Object.keys(disableReasons).filter((reason) => disableReasons[reason]),
      }))`);
  } finally {
    await page.close();
  }
}
