import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../browser/observer/redact.ts";
import { aggregate, browserOf } from "./e1-aggregate.ts";
import type { E1Browser, ProbeResult } from "./e1-aggregate.ts";
import { runSample } from "./e4-mechanisms.ts";
import type { Outcome, Plan } from "./e4-recipes.ts";
import { summarize } from "./e4-samples.ts";
import type { E4Sample, Mechanism, Trigger } from "./e4-samples.ts";
import { cleanup } from "./e4-steps.ts";
import { APP, CONTROL, control, expect, test } from "./page-loads.ts";
import type { Run } from "./page-loads.ts";
import { sized } from "./samples.ts";
import { appendVerdict, mergeCapabilities } from "./verdicts.ts";

// Hypotheses of PLAN.md P1.3; docs/poc/namespace-sessions/experiments/E4.md reports them.
// The harness drives pages and reads the ledger: every chrome.* call runs in the isolator.
const SAMPLES = sized(10);
/** Variants beside the main one, and mechanisms Chrome refuses, get fewer samples. */
const FEW = sized(3);
const ROTATION: Trigger[] = ["navigation", "post-message", "sync"];
const MECHANISMS: Mechanism[] = [
  "close-target",
  "terminate-execution",
  "debugger-pause",
  "dnr-block-evict",
  "unregister",
];

function repeat(mechanism: Mechanism, variant: string, count: number, triggers = ROTATION) {
  return Array.from({ length: count }, (_, index) => ({
    mechanism,
    variant,
    trigger: triggers[index % triggers.length] ?? "none",
  }));
}

// A run-wide index keeps every sample's marker distinct.
const PLANS: Plan[] = [
  ...repeat("close-target", "classic", SAMPLES),
  ...repeat("close-target", "module", FEW),
  ...repeat("close-target", "tab-session", FEW),
  // The isolator keeps its session across the stop and watches for the restart.
  ...repeat("close-target", "held", SAMPLES),
  ...repeat("close-target", "held-module", FEW),
  // Nothing to restart: the command either is refused or leaves the worker running.
  ...repeat("terminate-execution", "classic", FEW, ["none"]),
  ...repeat("debugger-pause", "classic", SAMPLES),
  // These close every client, so only a navigation is left to start the worker again.
  ...repeat("dnr-block-evict", "classic", SAMPLES, ["navigation"]),
  ...repeat("unregister", "classic", SAMPLES, ["navigation"]),
].map((plan, index) => ({ ...plan, index }));

/** `capabilities.json` entries: the command each mechanism needs from Chrome, per sample. */
const CAPABILITIES: {
  id: string;
  description: string;
  command: string;
  of: (plan: Plan) => boolean;
}[] = [
  {
    id: "e4-worker-close-target",
    description: "Target.closeTarget on the service worker's own session",
    command: "Target.closeTarget",
    of: (plan) => plan.mechanism === "close-target" && plan.variant !== "tab-session",
  },
  {
    id: "e4-tab-close-target",
    description: "Target.closeTarget on the tab session that auto-attached the service worker",
    command: "Target.closeTarget",
    of: (plan) => plan.variant === "tab-session",
  },
  {
    id: "e4-worker-terminate-execution",
    description: "Runtime.terminateExecution on the service worker's session",
    command: "Runtime.terminateExecution",
    of: (plan) => plan.mechanism === "terminate-execution",
  },
  {
    id: "e4-worker-debugger-pause-hold",
    description: "Debugger.pause on the service worker's session, held until Debugger.resume",
    command: "Debugger.pause",
    of: (plan) => plan.mechanism === "debugger-pause",
  },
  {
    id: "e4-dnr-block-service-worker-script",
    description:
      "A declarativeNetRequest session rule blocking the origin's service worker scripts",
    command: "updateSessionRules",
    of: (plan) => plan.mechanism === "dnr-block-evict",
  },
  {
    id: "e4-client-unregister",
    description: "registration.unregister() evaluated in the client through the tab session",
    command: "Runtime.evaluate",
    of: (plan) => plan.mechanism === "unregister",
  },
];

interface Ran {
  plan: Plan;
  outcome?: Outcome;
  error?: string;
}

/** Whether Chrome took the command, with its exact error when it did not. */
function probeOf(id: string, command: string, { outcome, error }: Ran): ProbeResult {
  const journal = outcome?.journal ?? { error: error ?? "no sample" };
  if ("error" in journal) return { id, status: "unavailable", error: journal.error };
  const sent = journal.calls.find((item) => item.method === command);
  if (!sent) return { id, status: "unavailable", error: `${command} was never sent` };
  const detail = journal.outcome;
  if (sent.error) return { id, status: "rejected", error: sent.error, detail };
  return { id, status: "allowed", detail };
}

function capabilitiesOf(ran: Ran[], browser: E1Browser): Record<string, unknown> {
  const entries = CAPABILITIES.map(({ id, description, command, of }) => {
    const results = ran.filter(({ plan }) => of(plan)).map((item) => probeOf(id, command, item));
    return [id, { description, ...aggregate(id, results, browser).capability }];
  });
  return Object.fromEntries(entries);
}

/** Leaves no page but the observer's and no worker behind after a sample that threw. */
async function recover(run: Run, keep: unknown): Promise<void> {
  for (const page of run.context.pages()) if (page !== keep) await page.close();
  await cleanup(run, []);
}

async function runAll(run: Run, keep: unknown): Promise<Ran[]> {
  const ran: Ran[] = [];
  for (const plan of PLANS) {
    try {
      ran.push({ plan, outcome: await runSample(run, plan) });
    } catch (error) {
      ran.push({ plan, error: String(error) });
      await recover(run, keep);
    }
  }
  return ran;
}

test.describe("E4: the extension stops a service worker and sees it start again", () => {
  test.describe.configure({ timeout: 2_400_000 });

  test("every stop mechanism runs its samples and gets a verdict", async ({
    extension,
    observer,
  }) => {
    await control("/__network?mode=online");
    await control("/__ledger/reset");
    // Headed Chrome holds a push permission prompt nobody answers; deny it instead.
    await extension.chrome.cdp.send("Browser.setPermission", {
      permission: { name: "notifications" },
      setting: "denied",
      origin: APP,
    });
    const run: Run = { extension, context: observer.page.context() };
    const ran = await runAll(run, observer.page);
    await observer.collectLedger(CONTROL);
    await mkdir(observer.directory, { recursive: true });
    await writeFile(
      join(observer.directory, "samples.json"),
      `${JSON.stringify(redact(ran), null, 2)}\n`,
    );

    const browser = browserOf(extension);
    const samples = ran.flatMap(({ outcome }) => (outcome ? [outcome.sample] : []));
    const of = (mechanism: Mechanism): E4Sample[] =>
      samples.filter((sample) => sample.mechanism === mechanism);
    const verdicts = MECHANISMS.map((mechanism) => summarize(mechanism, of(mechanism), browser));
    for (const verdict of verdicts) await appendVerdict(verdict);
    await mergeCapabilities({ stopControl: capabilitiesOf(ran, browser) });
    console.log(JSON.stringify(verdicts, null, 2));

    expect(ran.flatMap(({ plan, error }) => (error ? [`${plan.index}: ${error}`] : []))).toEqual(
      [],
    );
    const planned = (mechanism: Mechanism) => PLANS.filter((plan) => plan.mechanism === mechanism);
    expect(verdicts.map(({ hypothesis, samples: count }) => [hypothesis, count])).toEqual(
      MECHANISMS.map((mechanism) => [mechanism, planned(mechanism).length]),
    );
  });
});
