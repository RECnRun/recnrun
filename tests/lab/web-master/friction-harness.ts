import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { MARKER } from "./fsa-harness.ts";
import type { FsaWindow, FsaRun } from "./fsa-harness.ts";
import { call, jobOps, link } from "./lifecycle-harness.ts";
import type { Target } from "./target-server.ts";
import { NAME, done, provision } from "./trust-harness.ts";

/* Helpers of cell W.friction: the gesture log of each path, the shared steps, the first job. */

export interface Gesture {
  step: string;
  gesture: string;
  /** Simulated gestures have no display to keep: the Store is not reachable from the lab. */
  screenshot?: string;
  source?: string;
}

/** Equal in every path, so listed apart and left out of the totals (plan §4, W.friction). */
export const SHARED: Gesture[] = [
  {
    step: "one-line install",
    gesture: "paste `curl -fsSL https://recnrun.com/install.sh | sh` into a terminal, Enter",
    source: "PLAN decision 12; the onboarding script it runs pins the master key and allowlist",
  },
  {
    step: "base login",
    gesture: "log in once to each allowlisted site in the base before it is frozen",
    source: "PLAN decision 1 (base.sh); one per site, the same in every path",
  },
];

/**
 * The Store path, simulated as in P6.2: "Add to Chrome" and its confirm count 2; the dashboard's
 * folder onboarding is decision 3's, the same Chrome picker and prompts W.fsa drives in a tab.
 */
export const STORE: Gesture[] = [
  { step: "store", gesture: "Web Store listing: Add to Chrome", source: "P6.2 simulation" },
  { step: "store", gesture: "confirm dialog: Add extension", source: "P6.2 simulation" },
  {
    step: "onboarding",
    gesture: "dashboard: click Choose the rendezvous folder",
    source: "decision 3; the dashboard tab opens itself on install (0 gestures)",
  },
  { step: "onboarding", gesture: "picker: type the folder path, then Open", source: "decision 3" },
  { step: "onboarding", gesture: "write prompt: Allow", source: "decision 3" },
  {
    step: "onboarding",
    gesture: "dashboard: click Restore folder access",
    source: "decision 3 persistent consent; [unsure] P1.master-fsa",
  },
  {
    step: "onboarding",
    gesture: "restore prompt: Allow on every visit",
    source: "decision 3 persistent consent; [unsure] P1.master-fsa",
  },
  { step: "first job", gesture: "dashboard: click Run", source: "same as the website paths" },
];

/** A gesture log whose every real gesture keeps a screenshot of the whole display. */
export class FrictionLog {
  readonly gestures: Gesture[] = [];
  readonly fsa: FsaRun;
  constructor(fsa: FsaRun) {
    this.fsa = fsa;
  }

  async gesture(step: string, gesture: string): Promise<void> {
    const name = `${String(this.gestures.length + 1).padStart(2, "0")}-${step.replaceAll(" ", "-")}`;
    this.gestures.push({ step, gesture, screenshot: await this.fsa.screenshot(name) });
  }

  /** Takes over the gestures W.fsa's helpers logged, with the screenshot each step left. */
  async adopt(): Promise<void> {
    for (const { step, gesture } of this.fsa.gestures.splice(0)) await this.gesture(step, gesture);
  }
}

export async function evidence(): Promise<string> {
  const directory = join(
    ".artifacts/evidence",
    process.env.RECNRUN_RUN_ID ?? "local",
    "w-friction",
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function saveEvidence(name: string, record: unknown): Promise<void> {
  const path = join(await evidence(), `${name}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
}

/** A fresh rendezvous folder with its marker, as the one-line install leaves it. */
export async function rendezvous(): Promise<string> {
  const folder = join(homedir(), "RECnRun", "rendezvous");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, MARKER), JSON.stringify({ id: randomUUID() }));
  return folder;
}

/** The owner's click on Pair: the page's first and only key. */
export async function clickPair(page: Page, log: FrictionLog): Promise<JsonWebKey> {
  await expect(page.locator("#pair")).toBeVisible();
  await page.click("#pair");
  await expect(page.locator("#identity")).toHaveText("paired");
  await log.gesture("pairing", "click Pair");
  const key = await page.evaluate(() => (window as unknown as FsaWindow).lab.masterKey());
  if (!key) throw new Error("no key after Pair");
  return key;
}

interface FirstJob {
  page: Page;
  worker: LoadedExtension;
  target: Target;
  masterKey: JsonWebKey;
}

/** The onboarding script pins the key (no gesture), the link comes up, and Run gives a result. */
export async function firstJob(log: FrictionLog, job: FirstJob) {
  const { page, worker, target } = job;
  await provision(worker, { masterKey: job.masterKey, allowlist: [target.origin] });
  // The harness relays the SDP (as in W.rtc); the product signals through the folder, no gesture.
  expect(await link(page, worker, NAME)).toBe(true);
  const jobId = randomUUID();
  const reply = await call<{ status: string }>(page, "submit", NAME, {
    jobId,
    origins: [target.origin],
    ops: jobOps(target.origin, jobId),
  });
  expect(reply.status).toBe("ACCEPTED");
  const status = await done(worker, jobId);
  await call(page, "reconcile", NAME);
  await expect(page.locator("#journal")).toContainText("DONE");
  await log.gesture("first job", "click Run (lab: lab.submit), result shown in the journal");
  expect(target.count(jobId)).toBe(1);
  return { jobId, state: status.state, read: status.ops.at(-1)?.result };
}
