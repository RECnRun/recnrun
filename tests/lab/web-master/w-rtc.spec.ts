import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page, TestInfo } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import { loadUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";

/*
 * Cell W.rtc of docs/poc/thin-worker/PLAN.md §4: a page of the recnrun.com stand-in, in a normal
 * Chrome root with no extension, links over WebRTC (`iceServers: []`) to two workers on roots of
 * their own (one headless), each answering from an MV3 offscreen document. The harness relays the
 * SDP, which this cell does not measure (W.fsa tests the folder).
 */

const WORKER = fileURLToPath(new URL("worker-extension/", import.meta.url));
const LINK_TIMEOUT_MS = 20_000;
const PINGS = 100;
const run = promisify(execFile);

interface Candidate {
  type: string;
  address: string;
  port: number;
  protocol: string;
}

interface Lab {
  offer(name: string): Promise<string>;
  accept(name: string, sdp: string): Promise<number>;
  authenticate(name: string, pinned: JsonWebKey): Promise<boolean>;
  ping(name: string, count: number): Promise<number>;
  selectedPair(name: string): Promise<{ state: string; local: Candidate; remote: Candidate }>;
}

declare global {
  interface Window {
    lab: Lab;
  }
}

const hostCandidates = (sdp: string) =>
  sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=candidate:") && line.includes(" typ host"));

async function background<T>(worker: LoadedExtension, expression: string): Promise<T> {
  const value = (await worker.evaluateInBackground(expression)) as T | { error: string };
  if (value && typeof value === "object" && "error" in value) throw new Error(value.error);
  return value as T;
}

/** What the page's Local Network Access permission reads, or why it could not be read. */
const lnaState = (page: Page) =>
  page.evaluate(() =>
    navigator.permissions.query({ name: "local-network-access" as PermissionName }).then(
      (status) => status.state,
      (error: unknown) => `unreadable: ${String(error)}`,
    ),
  );

/** The address spaces Chrome's network service assigned: the page's own and each response's. */
async function addressSpaces(page: Page) {
  const session = await page.context().newCDPSession(page);
  const seen: { requests: unknown[]; responses: unknown[] } = { requests: [], responses: [] };
  session.on("Network.requestWillBeSentExtraInfo", (event) => {
    seen.requests.push(event.clientSecurityState ?? null);
  });
  session.on("Network.responseReceivedExtraInfo", (event) => {
    seen.responses.push(event.resourceIPAddressSpace);
  });
  await session.send("Network.enable");
  return seen;
}

/** The whole Xvfb display, where a Chrome prompt of the master would show. */
async function display(testInfo: TestInfo, name: string): Promise<string> {
  const path = testInfo.outputPath(`${name}.png`);
  await run("scrot", ["-o", path]);
  await testInfo.attach(name, { path, contentType: "image/png" });
  return path;
}

async function link(page: Page, worker: LoadedExtension, name: string) {
  const pinned = await background<JsonWebKey>(worker, "lab.identity()");
  const offer = await page.evaluate((id) => window.lab.offer(id), name);
  const answer = await background<string>(worker, `lab.answer(${JSON.stringify(offer)})`);
  const openMs = await page.evaluate(
    ([id, sdp, timeout]) =>
      Promise.race([
        window.lab.accept(id, sdp),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`channel ${id} did not open`)), timeout),
        ),
      ]),
    [name, answer, LINK_TIMEOUT_MS] as const,
  );
  const authenticated = await page.evaluate(([id, key]) => window.lab.authenticate(id, key), [
    name,
    pinned,
  ] as const);
  const pingsMs = await page.evaluate(([id, count]) => window.lab.ping(id, count), [
    name,
    PINGS,
  ] as const);
  const pair = await page.evaluate((id) => window.lab.selectedPair(id), name);
  return {
    name,
    offerHostCandidates: hostCandidates(offer),
    answerHostCandidates: hostCandidates(answer),
    openMs,
    authenticated,
    pingsMs,
    pair,
  };
}

async function evidence(variant: string, record: unknown): Promise<string> {
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `w-rtc-${variant}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** The master (a normal root, no extension) and two workers, each on a throwaway root of its own. */
async function startChromes(args: string[], opened: { close(): Promise<void> }[]) {
  const master: LaunchedChrome = await launchChrome({ args, silentDebugger: false });
  opened.push(master);
  const headed = await loadUnpacked(WORKER);
  opened.push(headed);
  const headless = await loadUnpacked(WORKER, { args: ["--headless"] });
  opened.push(headless);
  return { master, headed, headless };
}

async function openSite(master: LaunchedChrome, site: StandIn) {
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  const spaces = await addressSpaces(page);
  await page.goto(`${site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  const origin = await page.evaluate(() => ({ href: location.href, secure: isSecureContext }));
  expect(origin.secure).toBe(true);
  return { page, spaces, origin };
}

/** The technical pass: `.local` host candidates kept, an authenticated link, a selected pair. */
function assertLinks(links: Awaited<ReturnType<typeof link>>[]): void {
  for (const result of links) {
    expect(result.offerHostCandidates.length).toBeGreaterThan(0);
    for (const line of result.offerHostCandidates) expect(line).toMatch(/ [0-9a-f-]+\.local /);
    expect(result.authenticated).toBe(true);
    expect(result.pair.state).toBe("succeeded");
  }
}

let standIn: StandIn | undefined;

test.beforeAll(async () => {
  standIn = await startStandIn();
});

test.afterAll(async () => {
  await standIn?.close();
});

for (const variant of ["default", "public"] as const) {
  test(`W.rtc ${variant}: the stand-in page links to two separate-root workers`, async ({
    headless,
  }, testInfo) => {
    expect(headless).toBe(false);
    const site = standIn;
    if (!site) throw new Error("The HTTPS stand-in did not start.");
    // Scoped to the stand-in's endpoint, a lab emulation of recnrun.com; never a product flag.
    const args =
      variant === "public" ? [`--ip-address-space-overrides=127.0.0.1:${site.port}=public`] : [];
    const opened: { close(): Promise<void> }[] = [];
    try {
      const chromes = await startChromes(args, opened);
      const { page, spaces, origin } = await openSite(chromes.master, site);
      const before = await lnaState(page);
      const started = Date.now();
      const links = [];
      try {
        links.push(await link(page, chromes.headed, "headed"));
        links.push(await link(page, chromes.headless, "headless"));
      } finally {
        await display(testInfo, `display-${variant}`);
      }
      const record = {
        variant,
        chrome: chromes.master.version,
        masterFlags: chromes.master.flags,
        origin,
        lna: { before, after: await lnaState(page) },
        addressSpaces: spaces,
        totalMs: Date.now() - started,
        links,
      };
      testInfo.annotations.push({ type: "evidence", description: await evidence(variant, record) });
      console.log(JSON.stringify(record, null, 2));
      assertLinks(links);
    } finally {
      for (const chrome of opened.reverse()) await chrome.close();
    }
  });
}
