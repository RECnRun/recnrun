// Per-job ledger in storage.local, the result file, and the restart rule of plan §6.
export const TERMINAL = new Set(["DONE", "FAILED", "INTERRUPTED"]);
const PREFIX = "job:";

export const load = async (jobId) =>
  (await chrome.storage.local.get(PREFIX + jobId))[PREFIX + jobId];
export const save = (record) => chrome.storage.local.set({ [PREFIX + record.jobId]: record });

export const all = async () => {
  const entries = Object.entries(await chrome.storage.local.get(null));
  return entries.filter(([key]) => key.startsWith(PREFIX)).map(([, record]) => record);
};

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
};

/** One result file per job, through the worker's own Downloads (decision 4). */
export const publish = (record) =>
  chrome.downloads.download({
    url: `data:application/json;base64,${toBase64(JSON.stringify(record))}`,
    filename: `RECnRun/jobs/${record.jobId}.json`,
    conflictAction: "overwrite",
  });

export const resultFile = async (jobId) => {
  const [item] = await chrome.downloads.search({
    filenameRegex: `${jobId}\\.json$`,
    state: "complete",
    orderBy: ["-startTime"],
  });
  return item?.filename ?? null;
};

const afterRestart = (op) => {
  if (op.state === "APPLYING") return { ...op, state: "OUTCOME_UNKNOWN" };
  if (op.state === "PENDING" || op.state === "RUNNING") return { ...op, state: "SKIPPED" };
  return op;
};

/** A job whose runner died with its worker is never resumed: it ends INTERRUPTED. */
export const recover = async () => {
  const open = (await all()).filter((record) => !TERMINAL.has(record.state));
  for (const record of open) {
    const ended = { ...record, state: "INTERRUPTED", ops: record.ops.map(afterRestart) };
    await save(ended);
    await publish(ended);
  }
  return open.map((record) => record.jobId);
};
