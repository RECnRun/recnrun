// Whole-job runner of plan §6 (lab subset): accept once, run in order, keep running with no master.
import { checkJob, digestOf } from "./job-check.js";
import { utf8Length } from "./encoding.js";
import { bind, unbind } from "./capture.js";
import { barrier } from "./knobs.js";
import { load, publish, save } from "./ledger.js";
import { MUTATING, execute } from "./ops.js";

let running = null;
// W7: the interaction that holds the claim; a job and an interaction exclude each other.
let interacting = null;
/** @type {{ jobId: string, tabId: number, origins: string[], interactive?: boolean } | null} */
let active = null;

const push = (message) =>
  chrome.runtime.sendMessage({ target: "offscreen", type: "push", message }).catch(() => false);

const statusOf = (record) => ({ jobId: record.jobId, state: record.state, ops: record.ops });

const setOp = async (context, index, outcome) => {
  context.record.ops[index] = { op: context.job.ops[index].op, ...outcome };
  await save(context.record);
  void push({ type: "op-result", jobId: context.job.jobId, index, outcome });
};

const READ_BUDGET = 65_536;

const runFor = (context, index) => {
  const entry = context.job.ops[index];
  // The op's deadline is absolute: its own timeout, capped by the job's.
  const deadlineAt = Math.min(Date.now() + entry.timeoutMs, context.job.deadlineAt);
  const gate = (phase) => barrier(index, phase);
  // When the job's own deadline is the nearer bound, a timeout ends the job EXPIRED.
  const jobBound = context.job.deadlineAt <= Date.now() + entry.timeoutMs;
  const readBudget = READ_BUDGET - context.readBytes;
  return { origins: context.job.origins, deadlineAt, readBudget, gate, jobBound };
};

/** Runs one op between its barriers; answers whether the job goes on. */
const step = async (context, index) => {
  const entry = context.job.ops[index];
  await barrier(index, "between");
  await setOp(context, index, { state: MUTATING.has(entry.op) ? "APPLYING" : "RUNNING" });
  await barrier(index, "applying");
  const run = runFor(context, index);
  const outcome = await execute(context.target, entry, run);
  if (outcome.code === "TIMEOUT" && run.jobBound) context.expired = true;
  if (outcome.state === "DONE" && entry.op === "read") {
    context.readBytes += utf8Length(outcome.result.text);
  }
  await barrier(index, "afterEffect");
  await setOp(context, index, outcome);
  return outcome.state === "DONE";
};

const runOps = async (context) => {
  for (let index = 0; index < context.job.ops.length; index += 1) {
    if (await step(context, index)) continue;
    for (let rest = index + 1; rest < context.job.ops.length; rest += 1) {
      context.record.ops[rest] = { op: context.job.ops[rest].op, state: "SKIPPED" };
    }
    return context.expired ? "EXPIRED" : "FAILED";
  }
  return "DONE";
};

const run = async (job, record) => {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const target = { tabId: tab.id };
  active = { jobId: job.jobId, tabId: tab.id, origins: job.origins };
  await chrome.debugger.attach(target, "1.3");
  await chrome.debugger.sendCommand(target, "Page.enable");
  // A background tab is hidden and draws no frames, so a mouseMoved is never acked without it.
  await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", {
    enabled: true,
  });
  bind(target, job.jobId);
  try {
    record.state = await runOps({ job, record, target, readBytes: 0 });
  } finally {
    active = null;
    unbind(target);
    await chrome.debugger.detach(target).catch(() => false);
    await chrome.tabs.remove(tab.id).catch(() => false);
  }
  record.endedAt = Date.now();
  await save(record);
  await publish(record);
  void push({ type: "job-ended", ...statusOf(record) });
};

const replay = async (job, stored) =>
  stored.digest === (await digestOf(job))
    ? { status: "REPLAYED", ...statusOf(stored) }
    : { status: "PAYLOAD_MISMATCH", jobId: job.jobId };

const admit = async (job, provision) => {
  const refused = await checkJob(job, provision);
  if (refused) return { status: refused, jobId: job?.jobId };
  const stored = await load(job.jobId);
  if (stored) return replay(job, stored);
  if (running) return { status: "BUSY", jobId: running };
  if (interacting) return { status: "BUSY", jobId: job.jobId, holder: "interaction" };
  running = job.jobId;
  try {
    const ops = job.ops.map(({ op }) => ({ op, state: "PENDING" }));
    const record = { jobId: job.jobId, digest: await digestOf(job), state: "RUNNING", ops };
    record.acceptedAt = Date.now();
    await save(record);
    void run(job, record)
      .catch(async (error) => {
        await save({ ...record, state: "FAILED", error: String(error) });
      })
      .finally(() => {
        running = null;
      });
  } catch (error) {
    running = null;
    throw error;
  }
  return { status: "ACCEPTED", jobId: job.jobId };
};

// Admission is one critical section: check, ledger lookup, claim, and ledger write never interleave.
let admission = Promise.resolve();

const enqueue = (work) => {
  const result = admission.then(work);
  admission = result.catch(() => undefined);
  return result;
};

/** ACCEPTED only after the ledger holds the job; then the first op runs. */
export const submit = (job, provision) => enqueue(() => admit(job, provision));

/** Runs `check` inside admission, then claims the worker for `interactId`; writes no ledger entry. */
export const claimInteraction = (interactId, check) =>
  enqueue(async () => {
    const refused = await check();
    if (refused) return { status: refused };
    if (running || interacting) return { status: "BUSY" };
    interacting = interactId;
    return { status: "CLAIMED", interactId };
  });

/** W7: the claimed interaction's own tab is what observe binds to, under its interactId. */
export const holdTab = (interactId, tabId, origins) => {
  if (interacting === interactId) active = { jobId: interactId, tabId, origins, interactive: true };
};
export const dropTab = (tabId) => {
  if (active?.interactive && active.tabId === tabId) active = null;
};

// The interactive tab is closed before this is called.
export const releaseInteraction = (interactId) => {
  if (interacting === interactId) interacting = null;
};

/** The holder of the claim now: a job id, an interaction id, or null. */
export const claimed = () => running ?? interacting;

/** The job whose tab is open now, which an observe request must name. */
export const current = () => active;

export const statuses = async (jobIds) => {
  const records = await Promise.all(jobIds.map((jobId) => load(jobId)));
  return records.map((record, index) => {
    const interaction = active?.interactive && active.jobId === jobIds[index];
    if (interaction)
      return { jobId: active.jobId, state: "INTERACTING", ops: [], targetId: active.tabId };
    if (!record) return { jobId: jobIds[index], state: "NOT_FOUND", ops: [] };
    // The tab of the running job is what an observe request targets.
    const tab = active?.jobId === record.jobId ? { targetId: active.tabId } : {};
    return { ...statusOf(record), ...tab };
  });
};
