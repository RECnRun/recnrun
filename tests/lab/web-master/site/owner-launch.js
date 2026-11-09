// The owner page's launch: signed offer and request, polling, answer verification, then the lease.
import { parseStatus } from "./heartbeat.js";
import { readFile, writeFile } from "./owner-files.js";
import {
  buildRequest,
  sha256Hex,
  signOffer,
  spkiOk,
  spkiToJwk,
  verifyAnswer,
} from "./owner-pairing.js";
import { recall, remember } from "./owner-store.js";
import { retrying } from "./retry.js";

const ROOT = "w1";
const NAME = "worker";
const TTL_MS = 120_000;
const POLL_MS = 500;
const WAIT_MS = 90_000;
const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const must = (result, what) => {
  if (result.status !== "ok") throw new Error(`${what}: ${result.status}`);
};

const publish = async (context, ids) => {
  const { root, lab, key, workspace, session } = context;
  const { attempt, nonce, request } = ids;
  const now = Date.now();
  const sdp = await lab.offer(NAME);
  const fields = { v: 1, type: "offer", workspace, root: ROOT, attempt, nonce };
  const offer = await signOffer({ ...fields, issuedAt: now, expiresAt: now + TTL_MS, sdp }, key);
  const bytes = encode(JSON.stringify(offer));
  must(await writeFile(root, `exchange/${ROOT}/offer-${attempt}.json`, bytes), "offer");
  const expires = Math.floor(now / 1000) + TTL_MS / 1000;
  const hash = await sha256Hex(bytes);
  const text = await buildRequest(
    { workspace, session, request, root: ROOT, offer: hash, attempt, expires },
    key,
  );
  must(await writeFile(root, `requests/${request}.req`, encode(text)), "request");
};

const readJson = async (root, path) => {
  const read = await readFile(root, path);
  if (read.status !== "ok") return null;
  try {
    return JSON.parse(decode(read.bytes));
  } catch {
    return null;
  }
};

/** Polls the answer and the status; a refusal ends the wait with its code shown as it came. */
export const awaitAnswer = async (context, ids) => {
  const { root, say, waitMs = WAIT_MS } = context;
  for (const deadline = Date.now() + waitMs; Date.now() < deadline; await pause(POLL_MS)) {
    const answer = await readJson(root, `exchange/${ROOT}/answer-${ids.attempt}.json`);
    if (answer) return { ok: true, answer };
    const read = await readFile(root, `status/${ids.request}.status`);
    const status = read.status === "ok" ? parseStatus(decode(read.bytes)) : null;
    if (status?.state === "refused") return { ok: false, code: status.code ?? "REFUSED" };
    if (status) say(`launcher: ${status.state}`);
  }
  return { ok: false, code: "TIMEOUT" };
};

/** The worker key is pinned on first sight; a different one later is refused. */
export const pinWorker = async (root) => {
  const read = await readFile(root, `peers/${ROOT}/worker.spki`);
  if (read.status !== "ok") return { pin: "missing" };
  if (!spkiOk(read.bytes)) return { pin: "invalid" };
  const known = await recall("worker-spki");
  if (!known) await remember("worker-spki", read.bytes);
  const same =
    !known || (known.length === read.bytes.length && known.every((b, i) => b === read.bytes[i]));
  return { pin: same ? "ok" : "mismatch", spki: read.bytes };
};

const connect = async (context, ids, answer) => {
  const { root, lab, url } = context;
  const pinned = await pinWorker(root);
  if (pinned.pin !== "ok") return { ok: false, code: `WORKER_KEY_${pinned.pin.toUpperCase()}` };
  const expected = { attempt: ids.attempt, nonce: ids.nonce, root: ROOT };
  const verified = await verifyAnswer(answer, pinned.spki, expected);
  if (!verified.ok) return { ok: false, code: `ANSWER_${verified.reason}` };
  await lab.accept(NAME, answer.sdp);
  const proof = await lab.authenticate(NAME, await spkiToJwk(pinned.spki));
  if (!proof.ok) return { ok: false, code: "WORKER_PROOF" };
  return retrying(() => lab.interactStart(NAME, url));
};

/** Offers, requests and connects; resolves {ok} or {ok:false, code} with the first real refusal. */
export const launch = async (context) => {
  const ids = {
    attempt: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    request: crypto.randomUUID(),
  };
  await context.lab.interactStop(NAME).catch(() => null);
  await publish(context, ids);
  const waited = await awaitAnswer(context, ids);
  return waited.ok ? connect(context, ids, waited.answer) : waited;
};

export const LINK = NAME;
