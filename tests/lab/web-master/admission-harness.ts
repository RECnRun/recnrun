import { webcrypto } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { background, until } from "./lifecycle-harness.ts";
import type { JobStatus } from "./lifecycle-harness.ts";
import type { Reply } from "./trust-harness.ts";

/* Helpers of the W.admission cell: a Node-side master key, direct submits, and settling. */

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const TERMINAL = new Set(["DONE", "FAILED", "EXPIRED", "INTERRUPTED"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface Signer {
  publicKey: JsonWebKey;
  sign(fields: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** A master key the test holds, so it can sign any job and pin the public half on the worker. */
export async function signer(): Promise<Signer> {
  const pair = await webcrypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const publicKey = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    publicKey,
    async sign(fields) {
      const data = new TextEncoder().encode(canonical(fields));
      const raw = await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        data,
      );
      return { ...fields, signature: Buffer.from(raw).toString("base64") };
    },
  };
}

/** Hands a job to the worker's admission path, as a relayed `job` message would. */
export const submitDirect = (worker: LoadedExtension, job: Record<string, unknown>) =>
  background<Reply>(worker, `lab.submit(${JSON.stringify(job)})`);

export const ledger = (worker: LoadedExtension, jobId: string) =>
  background<(JobStatus & { endedAt?: number }) | undefined>(
    worker,
    `lab.job(${JSON.stringify(jobId)})`,
  );

const jobs = (worker: LoadedExtension) => background<JobStatus[]>(worker, "lab.jobs()");

/** Waits until no job of the worker is still open, so the next case starts on an idle worker. */
export async function settle(worker: LoadedExtension): Promise<void> {
  await until(
    () => jobs(worker),
    (all) => all.every((job) => TERMINAL.has(job.state)),
    60_000,
  );
  await delay(300);
}

export async function ended(worker: LoadedExtension, jobId: string) {
  const read = () => ledger(worker, jobId);
  const job = await until(read, (value) => Boolean(value && TERMINAL.has(value.state)), 60_000);
  if (!job) throw new Error(`job ${jobId} has no ledger entry`);
  return job;
}
