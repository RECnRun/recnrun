import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { call, until } from "./lifecycle-harness.ts";

/*
 * LAB-ONLY signalling helper of W6.16 (not a product path): a loopback HTTP mailbox that carries
 * the master's offer to a worker launched with no debugging flag, its answer and identity back,
 * and the worker's metrics posts. It replaces the CDP relay the other cells use; nothing in it
 * touches the worker's execution or capture.
 */

export interface RelayAnswer {
  answer: string;
  identity: JsonWebKey;
}

export interface LabSignalRelay {
  origin: string;
  /** The offer the worker's offscreen document takes on its next poll. */
  offer(sdp: string): void;
  /** Waits for the answer to the offer posted last. */
  answer(ms: number): Promise<RelayAnswer>;
  polls(): number;
  metrics: { at: number; body: unknown }[];
  close(): Promise<void>;
}

// The worker's posts are text/plain and its polls plain GETs, so no preflight is needed.
const CORS = { "access-control-allow-origin": "*" };

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

interface Mailbox {
  offer: string | null;
  answer: RelayAnswer | null;
  polls: number;
  metrics: { at: number; body: unknown }[];
}

function handler(box: Mailbox) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/offer") {
      box.polls += 1;
      const offer = box.offer;
      box.offer = null;
      if (offer === null) response.writeHead(204, CORS).end();
      else response.writeHead(200, { ...CORS, "content-type": "text/plain" }).end(offer);
      return;
    }
    if (request.method !== "POST" || !["/answer", "/metrics"].includes(request.url ?? "")) {
      response.writeHead(404, CORS).end();
      return;
    }
    void bodyOf(request).then((text) => {
      const body: unknown = JSON.parse(text);
      if (request.url === "/answer") box.answer = body as RelayAnswer;
      else box.metrics.push({ at: Date.now(), body });
      response.writeHead(204, CORS).end();
    });
  };
}

export async function startLabSignalRelay(): Promise<LabSignalRelay> {
  const box: Mailbox = { offer: null, answer: null, polls: 0, metrics: [] };
  const server = createServer(handler(box));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    offer: (sdp) => {
      box.answer = null;
      box.offer = sdp;
    },
    answer: async (ms) => {
      const read = () => Promise.resolve(box.answer);
      const answer = await until(read, (value) => value !== null, ms);
      if (!answer) throw new Error("no answer");
      return answer;
    },
    polls: () => box.polls,
    metrics: box.metrics,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Links the master page to the worker through the relay; the identity is pinned as relayed. */
export async function relayLink(page: Page, relay: LabSignalRelay, name: string, ms = 20_000) {
  const offer = await call<string>(page, "offer", name);
  relay.offer(offer);
  const { answer, identity } = await relay.answer(ms);
  await call<number>(page, "accept", name, answer);
  return call<{ ok: boolean }>(page, "authenticate", name, identity);
}
