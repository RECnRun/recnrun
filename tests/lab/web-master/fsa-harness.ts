import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page, TestInfo } from "@playwright/test";
import { expect, launchChrome } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { Native } from "../../e2e/fixtures/native-dialogs.ts";

/*
 * Shared steps of cell W.fsa: a master Chrome on a root that outlives each launch, the stand-in
 * page, Chrome's own picker and prompts driven with xdotool, and a log of every gesture and prompt.
 */

export const MARKER = "recnrun-rendezvous.json";
const run = promisify(execFile);
// Lets a prompt finish drawing before the display is kept; the driver itself waits on pixels.
const PROMPT_SETTLE_MS = 1_500;

interface FsaStatus {
  handle: boolean;
  name?: string;
  permission: string;
}

interface Fsa {
  status(): Promise<FsaStatus>;
  readMarker(): Promise<string>;
  writeFile(name: string, text: string): Promise<void>;
  persist(): Promise<{ persist: boolean; persisted: boolean }>;
  lastClick(): Promise<string> | undefined;
}

/** The page's lab API; cast inside `evaluate`, since W.rtc types `window.lab` its own way. */
export interface FsaWindow {
  lab: { fsa: Fsa; masterKey(): Promise<JsonWebKey | null>; pair(): Promise<JsonWebKey> };
}

export interface Step {
  label: string;
  at: string;
  permissionOnOpen: string;
  prompt?: string;
  permission?: string;
  marker?: boolean;
  written?: boolean;
  thumbprint?: string;
  screenshot: string;
  error?: string;
  /** The master Chrome's pid, so each restart is visibly a new process. */
  chromePid?: number;
  /** For the app variant: whether the page runs in a standalone app window. */
  standalone?: boolean;
}

/** One variant's record: every gesture a person would make, every prompt, every step. */
export class FsaRun {
  readonly gestures: { step: string; gesture: string }[] = [];
  readonly steps: Step[] = [];
  readonly variant: string;
  readonly directory: string;
  readonly testInfo: TestInfo;
  constructor(variant: string, directory: string, testInfo: TestInfo) {
    this.variant = variant;
    this.directory = directory;
    this.testInfo = testInfo;
  }

  gesture(step: string, gesture: string): void {
    this.gestures.push({ step, gesture });
  }

  /** The whole Xvfb display, kept in the evidence and attached to the report. */
  async screenshot(name: string): Promise<string> {
    const path = join(this.directory, `${this.variant}-${name}.png`);
    await run("scrot", ["-o", path]);
    await this.testInfo.attach(`${this.variant}-${name}`, { path, contentType: "image/png" });
    return path;
  }

  async save(extra: Record<string, unknown>): Promise<string> {
    const path = join(this.directory, `w-fsa-${this.variant}.json`);
    const record = { variant: this.variant, gestures: this.gestures, steps: this.steps, ...extra };
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
    return path;
  }
}

export async function evidenceDirectory(): Promise<string> {
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local", "w-fsa");
  await mkdir(directory, { recursive: true });
  return directory;
}

export const launchMaster = (userDataDir: string, pipe = false): Promise<LaunchedChrome> =>
  launchChrome({ userDataDir, pipe, silentDebugger: false });

export async function waitReady(page: Page): Promise<void> {
  await expect(page.locator("#status")).toHaveText("ready");
}

export async function openPage(master: LaunchedChrome, origin: string): Promise<Page> {
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await waitReady(page);
  return page;
}

/** The owner's explicit pairing: the only path that makes the page's master key. */
export const pair = (page: Page): Promise<JsonWebKey> =>
  page.evaluate(() => (window as unknown as FsaWindow).lab.pair());

/** The RFC 7638 thumbprint of the page's identity key (the master key of jobs.js). */
export async function thumbprint(page: Page): Promise<string> {
  const key = await page.evaluate(() => (window as unknown as FsaWindow).lab.masterKey());
  if (!key) throw new Error("The page holds no master key.");
  const { crv, kty, x, y } = key;
  const canonical = JSON.stringify({ crv, kty, x, y });
  return createHash("sha256").update(canonical).digest("base64url");
}

const status = (page: Page) =>
  page.evaluate(() => (window as unknown as FsaWindow).lab.fsa.status());
const lastClick = (page: Page) =>
  page.evaluate(() => (window as unknown as FsaWindow).lab.fsa.lastClick());

/** Onboarding: the click that opens the picker, the folder chosen, and the write prompt allowed. */
export async function onboard(page: Page, native: Native, folder: string, log: FsaRun) {
  const dialogs = await native.dialogs(page);
  await page.click("#choose");
  log.gesture("onboarding", "click Choose the rendezvous folder");
  await dialogs.chooseFolder(folder);
  log.gesture("onboarding", "picker: type the folder path, then Open");
  await page.waitForTimeout(PROMPT_SETTLE_MS);
  await log.screenshot("onboarding-write-prompt");
  await dialogs.answerWritePrompt("allow");
  log.gesture("onboarding", "write prompt: Allow");
  expect(await lastClick(page)).toBe("rendezvous");
}

/**
 * Restores access once, through whichever prompt Chrome shows, answering "Allow on every visit"
 * when it is the restore prompt; two gestures (the page's button, then the prompt).
 */
async function restoreAccess(page: Page, native: Native, step: Step, log: FsaRun) {
  const dialogs = await native.dialogs(page);
  await page.click("#restore");
  log.gesture(step.label, "click Restore folder access");
  await page.waitForTimeout(PROMPT_SETTLE_MS);
  await log.screenshot(`${step.label}-prompt`);
  step.prompt = await dialogs.allowInEitherPrompt();
  log.gesture(
    step.label,
    step.prompt === "restore" ? "restore: Allow on every visit" : "write: Allow",
  );
  expect(await lastClick(page)).toBe("granted");
}

/** Reads the marker, writes a file the harness reads back, and reads the identity thumbprint. */
async function exercise(page: Page, folder: string, step: Step): Promise<void> {
  const marker = JSON.parse(await readFile(join(folder, MARKER), "utf8")) as { id: string };
  step.marker = (
    await page.evaluate(() => (window as unknown as FsaWindow).lab.fsa.readMarker())
  ).includes(marker.id);
  const name = `fsa-${step.label}.txt`;
  await page.evaluate(
    ([file, text]) => (window as unknown as FsaWindow).lab.fsa.writeFile(file, text),
    [name, step.at] as const,
  );
  step.written = (await readFile(join(folder, name), "utf8")) === step.at;
  step.thumbprint = await thumbprint(page);
}

export interface Visit {
  page: Page;
  native: Native;
  folder: string;
  label: string;
  /** Whether this visit may still spend the one restore of onboarding. */
  mayRestore: boolean;
  chromePid: number;
}

/** One opening of the page: no gesture unless `mayRestore` and the grant is not there. */
export async function visit(log: FsaRun, options: Visit): Promise<Step> {
  const { page, label } = options;
  const permissionOnOpen = (await status(page)).permission;
  const at = new Date().toISOString();
  const screenshot = await log.screenshot(`${label}-open`);
  const step: Step = { label, at, permissionOnOpen, screenshot, chromePid: options.chromePid };
  log.steps.push(step);
  try {
    if (permissionOnOpen !== "granted" && options.mayRestore) {
      await restoreAccess(page, options.native, step, log);
      await log.screenshot(`${label}-restored`);
    }
    step.permission = (await status(page)).permission;
    if (step.permission === "granted") await exercise(page, options.folder, step);
  } catch (error) {
    step.error = String(error);
  }
  return step;
}

export const restoredAt = (log: FsaRun) => log.steps.find((step) => step.prompt)?.label;
