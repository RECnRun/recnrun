import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import { expectEveryHypothesis, recordHypothesis } from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";
import { sized } from "../experiments/samples.ts";
import { expect, test } from "./fixtures/chrome.ts";
import {
  announceClone,
  catalogPass,
  fieldText,
  masterScene,
  prepare,
  shows,
  statusOf,
} from "./fixtures/onboarding-rig.ts";
import type { MasterScene } from "./fixtures/onboarding-rig.ts";
import { within } from "./fixtures/trust.ts";

/*
 * POC PLAN.md P6.1 (CL16) on Google Chrome Stable: the master's dashboard section "Prepare
 * workers" writes request.json through chrome.downloads and shows the launcher's status.json and
 * registry.json. The launcher side is the real provision.sh, run step by step as the loop would run
 * it with catalog.sh between steps. Chrome on the base and the clones is the lab's stub; the base
 * already holds the extension (installBase), so the install step is the no-op until P6.2.
 */

const EXPERIMENT = "P6.1";
const CELLS = [
  "P6.1.request.written",
  "P6.1.steps.progress",
  "P6.1.done.byAcks",
  "P6.1.error.retry",
] as const;
const REQUEST_KEYS = [
  "operationId",
  "kind",
  "basesDir",
  "baseName",
  "clones",
  "namespace",
  "masterProfileId",
  "masterIdentity",
  "createdAt",
];
// One page poll (5 s) plus the time a status read takes.
const HOLD_MS = 7_000;

interface Stage {
  step: string;
  /** Runs before the launcher's pass. */
  before?: (scene: MasterScene) => void;
  /** The stub Chrome's environment for the pass. */
  env?: (scene: MasterScene) => Record<string, string>;
}

const STAGES: Stage[] = [
  { step: "create-base" },
  { step: "install", before: (scene) => void scene.rig.installBase() },
  {
    step: "template",
    env: ({ rig }) => ({ STUB_ACK: "good", STUB_ROOT: join(rig.bases, "base-v1", "downloads") }),
  },
  { step: "freeze" },
  { step: "create-clone" },
  { step: "open-clone", env: () => ({ STUB_CLONE: "1" }) },
];

/** One pass of the launcher's loop for the operation: provision.sh, then catalog.sh. */
async function pass(scene: MasterScene, stage?: Stage): Promise<number | null> {
  if (stage) stage.before?.(scene);
  const result = scene.rig.run(stage?.env?.(scene));
  await catalogPass(scene);
  return result.code;
}

/** Runs each stage and records whether the page shows its step; the status bytes come with it. */
async function walk(scene: MasterScene, id: string, stages: Stage[]) {
  const seen: { step: string; raw: string; onPage: boolean; code: number | null }[] = [];
  for (const stage of stages) {
    const code = await pass(scene, stage);
    const raw = await statusOf(scene, id);
    const onPage =
      (await shows(scene.dashboard, "step", stage.step)) &&
      (await fieldText(scene.dashboard, "phase")) === "running";
    seen.push({ step: stage.step, raw, onPage, code });
  }
  return seen;
}

interface Status {
  step: string;
  state: string;
  clones: { name: string; instanceId: string; boot: string; acked: boolean }[];
}

const failures = (checks: Record<string, boolean>) =>
  Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]));

const sampleOf = (
  checks: Record<string, boolean>,
  observation: Record<string, unknown>,
): Sample => {
  const failed = failures(checks);
  return failed.length === 0
    ? { ok: true, observation: { checks, ...observation } }
    : { ok: false, error: failed.join(", "), observation: { checks, ...observation } };
};

/** The request.json the page wrote: the closed grammar, in the order the launcher reads. */
async function requestSample(scene: MasterScene, id: string, text: string): Promise<Sample> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const checks = {
    keysInOrder: Object.keys(parsed).join() === REQUEST_KEYS.join(),
    noExtraBytes: JSON.stringify(parsed) === text,
    values:
      parsed.operationId === id &&
      parsed.kind === "prepare-workers" &&
      parsed.basesDir === scene.rig.bases &&
      parsed.baseName === "base-v1" &&
      parsed.clones === 2 &&
      parsed.namespace === "lab" &&
      parsed.masterProfileId === scene.profile.profileId,
    identityIsMasters: (parsed.masterIdentity as { key?: string }).key === scene.identityKey,
    pageSaysRequested: await shows(scene.dashboard, "phase", "requested", 5_000),
  };
  return sampleOf(checks, { request: text });
}

/** Every stage reached the page, and the status bytes after each are the closed layout. */
function stepsSample(seen: Awaited<ReturnType<typeof walk>>): Sample {
  const layout =
    /^\{"operationId":"[0-9a-f-]{36}","step":"[a-z-]+","state":"running","message":"[^"\\]*","clones":\[.*\],"updatedAt":\d{13}\}$/;
  const checks = {
    everyPassExitedZero: seen.every((each) => each.code === 0),
    everyStepOnPage: seen.every((each) => each.onPage),
    statusBytesClosed: seen.every((each) => layout.test(each.raw)),
    stepsInOrder:
      seen.map((each) => (JSON.parse(each.raw) as Status).step).join() ===
      STAGES.map((each) => each.step).join(),
  };
  return sampleOf(checks, { statuses: seen.map((each) => each.raw) });
}

/** Done shows only once both clones acked and the registry lists them with their boots. */
async function doneSample(scene: MasterScene, id: string): Promise<Sample> {
  const { dashboard } = scene;
  const rows = () => dashboard.locator('[data-field="clone"]').count();
  const linked = async (value: string) =>
    (await dashboard.locator('[data-field="linked"]').allTextContents()).join() === value;
  const opened = JSON.parse(await statusOf(scene, id)) as Status;
  const ackedOnPage = await within(
    async () =>
      (await dashboard.locator('[data-field="acked"]').allTextContents()).join() === "true,true"
        ? true
        : undefined,
    25_000,
  );
  const code = await pass(scene);
  const finished = JSON.parse(await statusOf(scene, id)) as Status;
  const reachedPage = await shows(dashboard, "step", "done");
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  const notYet = {
    phaseRunning: (await fieldText(dashboard, "phase")) === "running",
    noDone: (await fieldText(dashboard, "done")) === undefined,
    notLinked: await linked("false,false"),
  };
  for (const clone of finished.clones) await announceClone(scene, clone);
  await catalogPass(scene);
  const doneShown = await shows(dashboard, "done", "Done");
  const checks = {
    twoClonesAcked:
      opened.clones.length === 2 &&
      opened.clones.every((each) => each.acked) &&
      ackedOnPage === true,
    launcherSaysDone: code === 0 && finished.step === "done" && finished.state === "done",
    pageReadDone: reachedPage,
    ...notYet,
    onlyTwoRows: (await rows()) === 2,
    doneAfterRegistry: doneShown && (await linked("true,true")),
    phaseDone: (await fieldText(dashboard, "phase")) === "done",
  };
  return sampleOf(checks, { opened, finished });
}

/** One master, one operation to the end: the three cells the sample answers. */
async function fullSample(): Promise<{ request: Sample; steps: Sample; done: Sample }> {
  const scene = await masterScene();
  try {
    const { id, request } = await prepare(scene, 2);
    const asked = await requestSample(scene, id, request);
    const steps = stepsSample(await walk(scene, id, STAGES));
    return { request: asked, steps, done: await doneSample(scene, id) };
  } finally {
    await scene.dispose();
  }
}

/** A clone name taken forces an error; retry resumes the same step once it is free. */
async function errorSample(): Promise<Sample> {
  const scene = await masterScene();
  try {
    const { id } = await prepare(scene, 2);
    const { dashboard, rig } = scene;
    await walk(scene, id, STAGES.slice(0, 4));
    const taken = join(rig.bases, "clones", "w1");
    await mkdir(taken, { recursive: true });
    await pass(scene, STAGES[4]);
    const failed = JSON.parse(await statusOf(scene, id)) as Status & { message: string };
    const errorShown = await shows(dashboard, "phase", "error");
    const retryOffered = (await dashboard.locator('[data-field="retry"]').count()) === 1;
    const message = await fieldText(dashboard, "message");
    await rm(taken, { recursive: true });
    await dashboard.locator('[data-field="retry"]').click({ timeout: 15_000 });
    const retryFile = join(rig.folder(id), "retry");
    const written = await within(async () => (await stat(retryFile)).size, 15_000);
    const retrying = await shows(dashboard, "phase", "retrying", 10_000);
    await pass(scene, { step: "create-clone" });
    const resumed = JSON.parse(await statusOf(scene, id)) as Status;
    await pass(scene, STAGES[5]);
    const checks = {
      statusIsError:
        failed.step === "create-clone" &&
        failed.state === "error" &&
        /exit 73/.test(failed.message),
      pageShowsError: errorShown && message === failed.message,
      retryOffered,
      retryFileEmpty: written === 0,
      pageWaitsForLauncher: retrying,
      resumedSameStep: resumed.step === "create-clone" && resumed.state === "running",
      retryConsumed: await stat(retryFile).then(
        () => false,
        () => true,
      ),
      pageRunningAgain: await shows(dashboard, "phase", "running"),
      cloneRowsBack: (await dashboard.locator('[data-field="clone"]').count()) === 2,
    };
    return sampleOf(checks, {
      failed,
      resumed,
      bytes: await readFile(join(rig.folder(id), "status.json"), "utf8"),
    });
  } finally {
    await scene.dispose();
  }
}

test("Prepare workers writes the request and follows the launcher's steps to the clones' acks", async () => {
  test.setTimeout(1_200_000);
  const chrome = await labEnvironment.target.chrome();
  const cell = (hypothesis: string, topology: string): Cell => ({
    experiment: EXPERIMENT,
    hypothesis,
    chrome,
    environment: "lab",
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology,
    debugger: "none",
  });
  const [written, progress, byAcks, retry] = CELLS;
  const topology = "a master profile, provision.sh with a stub Chrome for the base and the clones";
  const queued: { steps: Sample[]; done: Sample[] } = { steps: [], done: [] };
  await recordHypothesis(cell(written, topology), async () => {
    const next = await fullSample();
    queued.steps.push(next.steps);
    queued.done.push(next.done);
    return next.request;
  });
  expect(queued.steps).toHaveLength(sized(3));
  const popped = (pick: "steps" | "done") => async () => {
    const next = queued[pick].shift();
    if (!next) throw new Error("No sample is left for this cell.");
    return next;
  };
  await recordHypothesis(cell(progress, topology), popped("steps"));
  await recordHypothesis(cell(byAcks, topology), popped("done"));
  await recordHypothesis(cell(retry, `${topology}, clone w1 taken`), errorSample);
  await expectEveryHypothesis(EXPERIMENT, CELLS);
});
