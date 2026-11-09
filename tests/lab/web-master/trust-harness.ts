import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { background, call, jobOps, link, until } from "./lifecycle-harness.ts";
import type { JobOp, JobStatus } from "./lifecycle-harness.ts";
import { SITE } from "./stand-in.ts";

/* Helpers of the W.trust cell: site variants, origin clears, raw jobs, and the worker's ledger. */

export const NAME = "worker";
const DONE_MS = 30_000;

export interface Reply {
  status: string;
  jobId?: string;
}

export interface Provision {
  masterKey: JsonWebKey;
  allowlist: string[];
  // W7: interaction stays off unless provisioning turns it on.
  interactEnabled?: boolean;
}

async function copySite(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "recnrun-lab-site-"));
  for (const name of await readdir(SITE)) await copyFile(join(SITE, name), join(directory, name));
  return directory;
}

/** A rebuilt site: every script renamed with a new hash, as a deploy of the same origin. */
export async function updatedSite(hash: string): Promise<string> {
  const directory = await copySite();
  const scripts = (await readdir(directory)).filter((name) => name.endsWith(".js"));
  const renamed = (name: string) => name.replace(/\.js$/, `-${hash}.js`);
  for (const name of await readdir(directory)) {
    let text = await readFile(join(directory, name), "utf8");
    for (const script of scripts) text = text.replaceAll(`/${script}"`, `/${renamed(script)}"`);
    await writeFile(join(directory, scripts.includes(name) ? renamed(name) : name), text);
  }
  return directory;
}

/** The same site loading `hostile.js` (unused by the honest page), which uses the stored key. */
export async function hostileSite(): Promise<string> {
  const directory = await copySite();
  const index = join(directory, "index.html");
  const tag = '<script type="module" src="/hostile.js"></script>';
  await writeFile(index, (await readFile(index, "utf8")).replace("</head>", `  ${tag}\n  </head>`));
  return directory;
}

/** `Storage.clearDataForOrigin` (and the HTTP cache for `cache`) through the page's session. */
export async function clearOrigin(page: Page, origin: string, kind: "cache" | "all") {
  const session = await page.context().newCDPSession(page);
  if (kind === "cache") await session.send("Network.clearBrowserCache");
  const storageTypes = kind === "cache" ? "cache_storage" : "all";
  await session.send("Storage.clearDataForOrigin", { origin, storageTypes });
  await session.detach();
}

/** Opens the master page, waits for its status, and links it to the worker. */
export async function openLinked(
  master: LaunchedChrome,
  origin: string,
  worker: LoadedExtension,
  ready = "ready",
): Promise<Page> {
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await expect(page.locator("#status")).toHaveText(ready);
  expect(await link(page, worker, NAME)).toBe(true);
  return page;
}

export const scripts = (page: Page) =>
  page.evaluate(() => [...document.scripts].map((script) => new URL(script.src).pathname));

export const masterKey = (page: Page) => call<JsonWebKey | null>(page, "masterKey");

/** The honest page's submit, through its own signing and journal. */
export const submit = (page: Page, origin: string, jobId = randomUUID()) =>
  call<Reply>(page, "submit", NAME, { jobId, origins: [origin], ops: jobOps(origin, jobId) });

export async function done(worker: LoadedExtension, jobId: string): Promise<JobStatus> {
  const read = () => background<JobStatus | undefined>(worker, `lab.job(${JSON.stringify(jobId)})`);
  const job = await until(read, (value) => value?.state === "DONE", DONE_MS);
  if (!job) throw new Error(`job ${jobId} has no ledger entry`);
  return job;
}

export const provisioned = (worker: LoadedExtension) =>
  background<Provision>(worker, "lab.provisioned()");
export const provision = (worker: LoadedExtension, value: Provision) =>
  background(worker, `lab.provision(${JSON.stringify(value)})`);

/** Job fields of plan §6 with `overrides` on top; the hostile page signs them as given. */
export function fields(origin: string, overrides: Record<string, unknown> = {}) {
  const jobId = randomUUID();
  const issuedAt = Date.now();
  const ops: JobOp[] = jobOps(origin, jobId);
  const base = { jobId, epoch: 1, issuedAt, deadlineAt: issuedAt + 600_000, origins: [origin] };
  return { ...base, tabRef: "lab", ops, ...overrides };
}

export const hostileJob = (page: Page, job: Record<string, unknown>) =>
  page.evaluate(
    ([name, value]) =>
      (
        window as unknown as { lab: { hostile: { job(n: string, j: unknown): Promise<Reply> } } }
      ).lab.hostile.job(name, value),
    [NAME, job] as const,
  );

export const hostileSend = (page: Page, message: Record<string, unknown>) =>
  page.evaluate(
    ([name, value]) =>
      (
        window as unknown as { lab: { hostile: { send(n: string, m: unknown): Promise<null> } } }
      ).lab.hostile.send(name, value),
    [NAME, message] as const,
  );
