import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended, ledger, settle, signer, submitDirect } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { background, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import type { JobOp } from "./lifecycle-harness.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { fields, provision } from "./trust-harness.ts";

/*
 * Cell W.admission, the review fixes of Phase W: one admission at a time, UTF-8 byte caps and the
 * read budget, a deadline that covers the preflight, a closed envelope schema, and no variant the
 * worker does not implement. The test holds the master key, so it signs what it likes.
 */

interface Cell {
  target: Target;
  worker: LoadedExtension;
  root: string;
  key: Signer;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W.admission setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const target = await startTarget();
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const key = await signer();
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  shared = { target, worker, root, key };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await c.worker.close().catch(() => undefined);
  await c.target.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Cases are independent: each starts on an idle worker, so one failure hides no other.
test.beforeEach(async () => {
  await settle(cell().worker);
});

const op = (name: string, args: Record<string, unknown>, timeoutMs = 5_000): JobOp => ({
  op: name,
  args,
  timeoutMs,
});

const textUrl = (c: Cell, character: string, count: number) =>
  `${c.target.origin}/text?c=${encodeURIComponent(character)}&n=${count}`;

const readJob = (c: Cell, character: string, count: number, reads: number) =>
  fields(c.target.origin, {
    ops: [
      op("navigate", { url: textUrl(c, character, count) }, 10_000),
      op("wait", { selector: "#t", state: "attached" }),
      ...Array.from({ length: reads }, () =>
        op("read", { selector: "#t", what: "text", maxBytes: 16_384 }),
      ),
    ],
  });

test("W.admission 1: concurrent identical submits run the job once", async () => {
  const c = cell();
  const job = await c.key.sign(fields(c.target.origin));
  const jobId = String(job.jobId);
  const replies = await Promise.all([submitDirect(c.worker, job), submitDirect(c.worker, job)]);
  expect(replies.map((reply) => reply.status).sort()).toEqual(["ACCEPTED", "REPLAYED"]);
  await ended(c.worker, jobId);
  await delay(500);
  expect(c.target.count(jobId)).toBe(1);
});

test("W.admission 2: concurrent different jobs run one and refuse the other", async () => {
  const c = cell();
  const first = await c.key.sign(fields(c.target.origin));
  const second = await c.key.sign(fields(c.target.origin));
  const replies = await Promise.all([
    submitDirect(c.worker, first),
    submitDirect(c.worker, second),
  ]);
  expect(replies.map((reply) => reply.status).sort()).toEqual(["ACCEPTED", "BUSY"]);
  const accepted = String(replies.find((reply) => reply.status === "ACCEPTED")?.jobId);
  // BUSY names the running job, as plan §6 has it.
  expect(replies.find((reply) => reply.status === "BUSY")?.jobId).toBe(accepted);
  const refused = String([first.jobId, second.jobId].find((id) => id !== accepted));
  await ended(c.worker, accepted);
  await delay(500);
  expect(c.target.count(accepted)).toBe(1);
  expect(c.target.count(refused)).toBe(0);
  expect(await ledger(c.worker, refused)).toBeUndefined();
});

/** Each case is signed by the pinned key and must be refused with its code, leaving no trace. */
async function refuse(c: Cell, label: string, job: Record<string, unknown>, status: string) {
  const reply = await submitDirect(c.worker, await c.key.sign(job));
  expect.soft(reply.status, label).toBe(status);
  const jobId = String(job.jobId);
  if (reply.status === "ACCEPTED") await settle(c.worker);
  expect.soft(await ledger(c.worker, jobId), label).toBeUndefined();
  expect.soft(c.target.count(jobId), label).toBe(0);
}

const withOp = (c: Cell, entry: JobOp) => {
  const job = fields(c.target.origin);
  return { ...job, ops: [...job.ops.slice(0, 1), entry] };
};

test("W.admission 3: caps count UTF-8 bytes, not characters", async () => {
  const c = cell();
  const cases: [string, Record<string, unknown>][] = [
    [
      "4-byte text, 1400 chars",
      withOp(c, op("type", { selector: "#text", text: "😀".repeat(1400) })),
    ],
    [
      "3-byte text, 1400 chars",
      withOp(c, op("type", { selector: "#text", text: "世".repeat(1400) })),
    ],
    ["2-byte selector, 301 chars", withOp(c, op("click", { selector: `#${"é".repeat(300)}` }))],
    [
      "envelope of 32 x 3900 bytes in 41600 chars",
      fields(c.target.origin, {
        ops: Array.from({ length: 32 }, () =>
          op("type", { selector: "#text", text: "世".repeat(1300) }),
        ),
      }),
    ],
  ];
  for (const [label, job] of cases) await refuse(c, label, job, "INVALID_COMMAND");
});

test("W.admission 4: a read is cut to maxBytes without splitting a code point", async () => {
  const c = cell();
  const job = await c.key.sign(readJob(c, "€", 10_000, 1));
  const jobId = String(job.jobId);
  expect((await submitDirect(c.worker, job)).status).toBe("ACCEPTED");
  const status = await ended(c.worker, jobId);
  expect(status.state).toBe("DONE");
  const text = (status.ops[2]?.result as { text: string } | undefined)?.text ?? "";
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16_384);
  expect(text).toBe("€".repeat(5_461));
});

test("W.admission 5: reads over 64 KiB in one job are stopped", async () => {
  const c = cell();
  const job = await c.key.sign(readJob(c, "a", 20_000, 5));
  const jobId = String(job.jobId);
  expect((await submitDirect(c.worker, job)).status).toBe("ACCEPTED");
  const status = await ended(c.worker, jobId);
  expect(status.ops.slice(2).map((entry) => entry.code ?? entry.state)).toEqual([
    "DONE",
    "DONE",
    "DONE",
    "DONE",
    "READ_BUDGET",
  ]);
  expect(status.state).toBe("FAILED");
});

test("W.admission 6: a preflight held past the deadline sends no click", async () => {
  const c = cell();
  const issuedAt = Date.now();
  const deadlineAt = issuedAt + 3_000;
  const job = await c.key.sign(fields(c.target.origin, { issuedAt, deadlineAt }));
  const jobId = String(job.jobId);
  await background(c.worker, `lab.setKnob(${JSON.stringify({ index: 2, phase: "preflight" })})`);
  expect((await submitDirect(c.worker, job)).status).toBe("ACCEPTED");
  const reached = () => background<{ reached: { index: number } | null }>(c.worker, "lab.state()");
  await until(reached, (value) => value.reached?.index === 2, 30_000);
  await delay(Math.max(0, deadlineAt + 500 - Date.now()));
  await background(c.worker, "lab.release()");
  const status = await ended(c.worker, jobId);
  await delay(1_500);
  await background(c.worker, "lab.setKnob(null)");
  expect(c.target.count(jobId)).toBe(0);
  expect(status.state).toBe("EXPIRED");
  expect(status.ops[2]?.code).toBe("TIMEOUT");
  expect(status.ops.slice(3).map((entry) => entry.state)).toEqual(["SKIPPED", "SKIPPED"]);
});

test("W.admission 7: variants the worker does not implement are refused", async () => {
  const c = cell();
  const wait = (state: string) => op("wait", { selector: "#text", state });
  const cases: [string, Record<string, unknown>][] = [
    ["wait visible", withOp(c, wait("visible"))],
    ["wait text", withOp(c, wait("text"))],
    ["read value", withOp(c, op("read", { selector: "#text", what: "value", maxBytes: 64 }))],
  ];
  for (const [label, job] of cases) await refuse(c, label, job, "INVALID_COMMAND");
});

test("W.admission 8: the envelope is closed", async () => {
  const c = cell();
  const now = Date.now();
  const job = (overrides: Record<string, unknown>) => fields(c.target.origin, overrides);
  const cases: [string, Record<string, unknown>][] = [
    ["unknown key", job({ note: "x" })],
    ["fractional issuedAt", job({ issuedAt: now + 0.5, deadlineAt: now + 0.5 + 600_000 })],
    ["unsafe integer timestamps", job({ issuedAt: 2 ** 60, deadlineAt: 2 ** 60 + 1_024 })],
    ["epoch string", job({ epoch: "1" })],
    ["epoch object", job({ epoch: { n: 1 } })],
    ["epoch negative", job({ epoch: -1 })],
    ["epoch fractional", job({ epoch: 1.5 })],
    ["epoch null", job({ epoch: null })],
    ["tabRef number", job({ tabRef: 7 })],
    ["tabRef empty", job({ tabRef: "" })],
    ["tabRef path", job({ tabRef: "../x" })],
    ["jobId not a uuid", job({ jobId: "not-a-uuid" })],
    ["jobId traversal", job({ jobId: "../../etc/passwd" })],
    ["jobId slash in uuid shape", job({ jobId: `${randomUUID().slice(0, 35)}/` })],
  ];
  for (const [label, entry] of cases) await refuse(c, label, entry, "INVALID_COMMAND");
});
