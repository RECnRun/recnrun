// Whole-job runner of plan §6 (lab subset): accept once, run in order, keep running with no master.
import { checkJob, digestOf } from "./job-check.js";
import { barrier } from "./knobs.js";
import { load, publish, save } from "./ledger.js";
import { MUTATING, execute } from "./ops.js";

let running = null;

const push = (message) =>
  chrome.runtime.sendMessage({ target: "offscreen", type: "push", message }).catch(() => false);

const statusOf = (record) => ({ jobId: record.jobId, state: record.state, ops: record.ops });

const setOp = async (context, index, outcome) => {
  context.record.ops[index] = { op: context.job.ops[index].op, ...outcome };
  await save(context.record);
  void push({ type: "op-result", jobId: context.job.jobId, index, outcome });
};

/** Runs one op between its barriers; answers whether the job goes on. */
const step = async (context, index) => {
  const entry = context.job.ops[index];
  await barrier(index, "between");
  await setOp(context, index, { state: MUTATING.has(entry.op) ? "APPLYING" : "RUNNING" });
  await barrier(index, "applying");
  const outcome = await execute(context.target, entry, context.job.origins);
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
    return "FAILED";
  }
  return "DONE";
};

const run = async (job, record) => {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, "1.3");
  await chrome.debugger.sendCommand(target, "Page.enable");
  try {
    record.state = await runOps({ job, record, target });
  } finally {
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

/** ACCEPTED only after the ledger holds the job; then the first op runs. */
export const submit = async (job, provision) => {
  const refused = await checkJob(job, provision);
  if (refused) return { status: refused, jobId: job?.jobId };
  const stored = await load(job.jobId);
  if (stored) return replay(job, stored);
  if (running) return { status: "BUSY", jobId: running };
  const ops = job.ops.map(({ op }) => ({ op, state: "PENDING" }));
  const record = { jobId: job.jobId, digest: await digestOf(job), state: "RUNNING", ops };
  record.acceptedAt = Date.now();
  await save(record);
  running = job.jobId;
  void run(job, record)
    .catch(async (error) => {
      await save({ ...record, state: "FAILED", error: String(error) });
    })
    .finally(() => {
      running = null;
    });
  return { status: "ACCEPTED", jobId: job.jobId };
};

export const statuses = async (jobIds) => {
  const records = await Promise.all(jobIds.map((jobId) => load(jobId)));
  return records.map((record, index) =>
    record ? statusOf(record) : { jobId: jobIds[index], state: "NOT_FOUND", ops: [] },
  );
};
