import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { POC_EXTENSION_ID } from "../../browser/fixtures/downloads-profiles.ts";
import { chromesOf, installProfile, skeleton } from "../../browser/fixtures/launcher-rig.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import type { Sample } from "../../experiments/outcome.ts";
import { quit } from "../../experiments/fixtures/launcher-open.ts";

/*
 * E13's diagnostic cell (POC PLAN.md P7.4, R10): one worker opened with open.sh's own arguments in
 * --headless=new, plus a debugging port, so the lab reads what its only target is and what the
 * extension's tabs API and the product's shared-tab filter make of it. No verdict of a worker
 * without a client rests on this cell.
 */

const ENDPOINT_MS = 30_000;
const PAGE_MS = 30_000;

async function endpointOf(root: string) {
  const read = async () => {
    const text = await readFile(join(root, "DevToolsActivePort"), "utf8").catch(() => "");
    const [port = "", path = ""] = text.trim().split("\n");
    return path.startsWith("/devtools/browser/") ? `ws://127.0.0.1:${port}${path}` : undefined;
  };
  const found = await within(read, ENDPOINT_MS);
  if (!found) throw new Error(`no DevToolsActivePort in ${root} within ${ENDPOINT_MS} ms`);
  return found;
}

interface Listed {
  own: string;
  tabs: { id?: number; windowId: number; url?: string }[];
  windows: { id?: number; type?: string; tabs: number }[];
}

interface PageChrome {
  tabs: { query(filter: object): Promise<{ id?: number; windowId: number; url?: string }[]> };
  windows: {
    getAll(filter: object): Promise<{ id?: number; type?: string; tabs?: unknown[] }[]>;
  };
  runtime: { getURL(path: string): string };
}

/** What the extension's own page reads: every tab, the normal windows, and its own origin. */
const listInPage = async (): Promise<Listed> => {
  const { chrome } = globalThis as unknown as { chrome: PageChrome };
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return {
    own: chrome.runtime.getURL("/"),
    tabs: tabs.map(({ id, windowId, url }) => ({ id, windowId, url })),
    windows: windows.map(({ id, type, tabs: each = [] }) => ({ id, type, tabs: each.length })),
  };
};

/** diag.bootstrapTab: the bootstrap target is a tab of a normal window, and the shared tabs leave it out. */
export async function bootstrapTabSample(): Promise<Sample> {
  const rig = await skeleton(undefined, ["--remote-debugging-port=0"]);
  const root = join(rig.dir, "worker");
  try {
    await installProfile(root, join(rig.dir, "downloads"), rig.record, "Default");
    await rm(join(root, "DevToolsActivePort"), { force: true });
    const url = `chrome-extension://${POC_EXTENSION_ID}/bootstrap.html#token=diagnostic`;
    const args = ["--headless=new", `--user-data-dir=${root}`, "--profile-directory=Default"];
    const child = spawn(
      join(rig.dir, "bin", "google-chrome"),
      [...args, "--no-first-run", "--no-default-browser-check", url],
      { env: rig.env, stdio: "ignore" },
    );
    try {
      return await observe(root);
    } finally {
      await quit({ survivors: () => chromesOf(root) }, [child.pid ?? 0]);
    }
  } finally {
    await rig.dispose();
  }
}

async function observe(root: string): Promise<Sample> {
  const browser = await chromium.connectOverCDP(await endpointOf(root));
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: { type: string; url: string }[];
    };
    const targets = targetInfos.map(({ type, url }) => ({ type, url }));
    const page = await within(
      async () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((each) => each.url().includes("bootstrap.html")),
      PAGE_MS,
    );
    if (!page) return judged(["no bootstrap page target"], { targets });
    const listed = await page.evaluate(listInPage);
    // tabs/open-tabs.ts toBrowserTabs: the extension's own pages are nothing to record.
    const shared = listed.tabs.filter(
      (tab) => tab.id !== undefined && !tab.url?.startsWith(listed.own),
    );
    const problems: string[] = [];
    const bootstrap = listed.tabs.filter((tab) => tab.url?.includes("bootstrap.html"));
    if (bootstrap.length !== 1) problems.push("tabs.query does not list the bootstrap page once");
    if (listed.windows.every((each) => each.tabs === 0)) problems.push("no normal window holds it");
    if (shared.length !== 0) problems.push("the shared tabs keep a page");
    return judged(problems, { targets, ...listed, shared: shared.length });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
