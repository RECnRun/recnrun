// Throwaway master jobs: a non-extractable key, signed jobs, a journal, and reconcile (plan §6).
const JOURNAL = "recnrun-lab-journal";
const TERMINAL = new Set(["DONE", "FAILED", "EXPIRED", "INTERRUPTED"]);
const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));

export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const request = (operation) =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });

const keyStore = async (mode) => {
  const open = indexedDB.open("recnrun-lab", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("keys");
  return (await request(open)).transaction("keys", mode).objectStore("keys");
};

const storedPair = async () => request((await keyStore("readonly")).get("master"));

const showIdentity = (paired) => {
  document.getElementById("identity").textContent = paired ? "paired" : "Pair again";
  document.getElementById("pair").hidden = paired;
};

// Only the owner's explicit pairing makes a key; a page that lost it never makes one by itself.
const pair = async () => {
  const stored = await storedPair();
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const made = stored ?? (await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"]));
  if (!stored) await request((await keyStore("readwrite")).put(made, "master"));
  showIdentity(true);
  return crypto.subtle.exportKey("jwk", made.publicKey);
};

const masterKey = async () => {
  const stored = await storedPair();
  showIdentity(Boolean(stored));
  return stored ? crypto.subtle.exportKey("jwk", stored.publicKey) : null;
};

const sign = async (fields) => {
  const data = new TextEncoder().encode(canonical(fields));
  const ecdsa = { name: "ECDSA", hash: "SHA-256" };
  const stored = await storedPair();
  if (!stored) throw new Error("PAIR_AGAIN");
  const signature = await crypto.subtle.sign(ecdsa, stored.privateKey, data);
  return { ...fields, signature: toBase64(signature) };
};

const readJournal = () => JSON.parse(localStorage.getItem(JOURNAL) ?? "{}");

const render = (journal) => {
  const lines = Object.entries(journal).map(([jobId, entry]) => {
    const ops = (entry.ops ?? []).map((op) =>
      op.state === "OUTCOME_UNKNOWN" ? `${op.op} unknown` : `${op.op} ${op.state}`,
    );
    return `${jobId} ${entry.state}: ${ops.join(", ")}`;
  });
  document.getElementById("journal").textContent = lines.join("\n");
};

const record = (jobId, patch) => {
  const journal = readJournal();
  journal[jobId] = { ...journal[jobId], ...patch };
  localStorage.setItem(JOURNAL, JSON.stringify(journal));
  render(journal);
};

export const createJobs = ({ links, nextMessage }) => {
  let sent = 0;
  const submit = async (name, { jobId, origins, ops }) => {
    const issuedAt = Date.now();
    const fields = { jobId, epoch: 1, issuedAt, deadlineAt: issuedAt + 600_000, origins };
    const job = await sign({ ...fields, tabRef: "lab", ops });
    // Journaled before it is sent, so a reopened page asks for it instead of sending it again.
    record(jobId, { state: "SUBMITTED", ops: [] });
    const { channel } = links.get(name);
    const reply = nextMessage(channel, "job-reply");
    sent += 1;
    channel.send(JSON.stringify({ type: "job", job }));
    const answer = await reply;
    record(jobId, { state: answer.status === "ACCEPTED" ? "ACCEPTED" : answer.status });
    return answer;
  };
  const reconcile = async (name) => {
    const open = Object.entries(readJournal()).filter(([, entry]) => !TERMINAL.has(entry.state));
    const jobIds = open.map(([jobId]) => jobId);
    if (jobIds.length === 0) return [];
    const { channel } = links.get(name);
    const reply = nextMessage(channel, "job-status-reply");
    channel.send(JSON.stringify({ type: "job-status", jobIds }));
    const { jobs } = await reply;
    for (const job of jobs) record(job.jobId, { state: job.state, ops: job.ops });
    return jobs;
  };
  render(readJournal());
  void masterKey();
  document.getElementById("pair").addEventListener("click", () => void pair());
  return { pair, masterKey, submit, reconcile, journal: readJournal, sent: () => sent };
};
