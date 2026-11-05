import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { POC_EXTENSION_ID } from "../../browser/fixtures/downloads-profiles.ts";
import { askPeers } from "../../browser/fixtures/master-restart.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { judged } from "../../experiments/fixtures/downloads-verdicts.ts";
import type { Sample } from "../../experiments/outcome.ts";
import { bindMasterSide, masterLinked } from "./e13-cells.ts";
import { dockerRig, v1Lab } from "./e13-lab.ts";
import type { Lab, LabRig } from "./e13-lab.ts";

/*
 * E13's diagnostic cell (POC PLAN.md P7.4, R10): one worker opened by open.sh, its own arguments
 * plus a debugging port, so the lab reads what its only target is and what the product shares of
 * it: the master asks the worker for its tabs over the verified link, as the dashboard does. No
 * verdict of a worker without a client rests on this cell.
 */

const ENDPOINT_MS = 30_000;
const BOOTSTRAP = `chrome-extension://${POC_EXTENSION_ID}/bootstrap.html`;

/** The lab's rig with a debugging port on the launcher's Chrome, which the diagnostic alone allows. */
const debuggable = (rig: LabRig): LabRig => ({
  ...rig,
  frame: (flags) => rig.frame([...flags, "--remote-debugging-port=0"]),
});

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

interface Target {
  type: string;
  url: string;
}

interface Shared {
  tabs?: { url?: string }[];
}

/** Every page target must be the bootstrap tab, exactly one, and the product must share none. */
function targetProblems(targets: Target[], token: string, shared: Shared["tabs"]): string[] {
  const problems: string[] = [];
  const pages = targets.filter(({ type }) => type === "page");
  const [only] = pages;
  if (pages.length !== 1) problems.push(`${pages.length} page targets, not exactly one`);
  if (only && !only.url.startsWith(BOOTSTRAP)) problems.push(`the page target is ${only.url}`);
  if (only && !only.url.includes(token)) problems.push("the page target does not carry the token");
  if (shared === undefined) problems.push("the master got no tabs of the worker");
  else if (shared.length !== 0) problems.push(`the product shares ${shared.length} tab(s)`);
  return problems;
}

/** diag.bootstrapTab: the worker's only page target is its bootstrap tab, and the product shares nothing. */
export async function bootstrapTabSample(): Promise<Sample> {
  const lab = await v1Lab(1, debuggable(dockerRig));
  try {
    return await observe(lab);
  } finally {
    await lab.dispose();
  }
}

async function observe(lab: Lab) {
  const [worker] = lab.workers;
  if (!worker) throw new Error("The diagnostic has no worker.");
  const opened = await lab.open(worker, "headless");
  if (opened.code !== 0)
    return judged([`open exited ${opened.code} ${opened.stderr.slice(-160)}`], {});
  const problems: string[] = [];
  // A client that attaches earlier changes the download behavior the rendezvous needs, so it waits.
  if (!(await masterLinked(lab, [worker.profileId]))) problems.push("the master never linked it");
  problems.push(...(await bindMasterSide(lab)).problems);
  const reply = await askPeers(lab.dashboard, { type: "tabs", peer: worker.profileId });
  const shared = reply.ok ? (reply.result as Shared).tabs : undefined;
  const targets = await targetsOf(worker.root);
  problems.push(...targetProblems(targets, worker.token, shared));
  return judged(problems, { targets, shared: shared?.length ?? null });
}

/** The targets of the worker, read over the debugging port by a client that attaches last. */
async function targetsOf(root: string): Promise<Target[]> {
  const browser = await chromium.connectOverCDP(await endpointOf(root));
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: Target[] };
    return targetInfos.map(({ type, url }) => ({ type, url }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}
