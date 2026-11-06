import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { background, jobOps } from "./lifecycle-harness.ts";
import type { JobOp } from "./lifecycle-harness.ts";
import type { Target } from "./target-server.ts";
import { done, fields, hostileJob, hostileSend } from "./trust-harness.ts";
import type { Provision } from "./trust-harness.ts";

/* The hostile page's attempts in W.trust 3: one allowed job, then every refusal of plan §6. */

interface Bound {
  target: Target;
  outside: Target;
  worker: LoadedExtension;
  pinned: Provision;
}

interface Attempt {
  label: string;
  job: Record<string, unknown>;
  status: string;
}

const op = (name: string, args: Record<string, unknown>, timeoutMs = 5_000): JobOp => ({
  op: name,
  args,
  timeoutMs,
});

function withOp(origin: string, entry: JobOp) {
  const job = fields(origin);
  return { ...job, ops: [...job.ops.slice(0, 1), entry] };
}

function attempts(origin: string, outside: string): Attempt[] {
  const forbiddenNavigate = fields(origin);
  const job = (overrides: Record<string, unknown>) => fields(origin, overrides);
  return [
    { label: "origin outside the allowlist", job: fields(outside), status: "FORBIDDEN_ORIGIN" },
    {
      label: "navigate outside the job's origins",
      job: { ...forbiddenNavigate, ops: jobOps(outside, String(forbiddenNavigate.jobId)) },
      status: "FORBIDDEN_ORIGIN",
    },
    {
      label: "job widens its allowlist",
      job: job({ allowlist: [outside] }),
      status: "INVALID_COMMAND",
    },
    {
      label: "op outside the set",
      job: withOp(origin, op("evaluate", { expression: "1" })),
      status: "INVALID_COMMAND",
    },
    {
      label: "script argument",
      job: withOp(origin, op("navigate", { url: `${origin}/form`, script: "x" })),
      status: "INVALID_COMMAND",
    },
    {
      label: "javascript: URL",
      job: withOp(origin, op("navigate", { url: "javascript:alert(1)" })),
      status: "INVALID_COMMAND",
    },
    {
      label: "33 ops",
      job: job({
        ops: Array.from({ length: 33 }, () => op("wait", { selector: "#text", state: "attached" })),
      }),
      status: "INVALID_COMMAND",
    },
    {
      label: "deadline over 10 min",
      job: job({ deadlineAt: Date.now() + 600_001 }),
      status: "INVALID_COMMAND",
    },
    {
      label: "op timeout over 30 s",
      job: withOp(origin, op("click", { selector: "#send" }, 30_001)),
      status: "INVALID_COMMAND",
    },
    {
      label: "text over 4096",
      job: withOp(origin, op("type", { selector: "#text", text: "x".repeat(4097) })),
      status: "INVALID_COMMAND",
    },
    {
      label: "selector over 512",
      job: withOp(origin, op("click", { selector: `#${"a".repeat(512)}` })),
      status: "INVALID_COMMAND",
    },
    {
      label: "read over 16 KiB",
      job: withOp(origin, op("read", { selector: "#text", what: "text", maxBytes: 16_385 })),
      status: "INVALID_COMMAND",
    },
    {
      label: "job over 64 KiB",
      job: job({
        ops: Array.from({ length: 32 }, () =>
          op("type", { selector: "#text", text: "x".repeat(4_000) }),
        ),
      }),
      status: "INVALID_COMMAND",
    },
  ];
}

/** Messages a page could send to widen the allowlist; the worker has no such message. */
async function widen(page: Page, b: Bound) {
  const allowlist = [...b.pinned.allowlist, b.outside.origin];
  await hostileSend(page, { type: "provision", value: { ...b.pinned, allowlist } });
  await hostileSend(page, { type: "allowlist", origins: allowlist });
}

export async function refusals(page: Page, b: Bound) {
  const allowed = fields(b.target.origin);
  const reply = await hostileJob(page, allowed);
  expect(reply.status).toBe("ACCEPTED");
  await done(b.worker, String(allowed.jobId));
  expect(b.target.count(String(allowed.jobId))).toBe(1);
  await widen(page, b);
  const outcomes: { label: string; status: string; ledger: boolean }[] = [];
  for (const attempt of attempts(b.target.origin, b.outside.origin)) {
    const jobId = String(attempt.job.jobId);
    const { status } = await hostileJob(page, attempt.job);
    const ledger = (await background(b.worker, `lab.job(${JSON.stringify(jobId)})`)) !== undefined;
    outcomes.push({ label: attempt.label, status, ledger });
    expect.soft(status, attempt.label).toBe(attempt.status);
    expect.soft(ledger, attempt.label).toBe(false);
    expect.soft(b.target.count(jobId), attempt.label).toBe(0);
  }
  return { allowed: allowed.jobId, outcomes };
}
