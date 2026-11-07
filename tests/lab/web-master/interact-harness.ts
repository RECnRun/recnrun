import type { Page } from "@playwright/test";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { background, call, until } from "./lifecycle-harness.ts";
import { NAME } from "./trust-harness.ts";

/* Helpers of the W7 slice A cells: the page's input.v1 client and the worker's interaction state. */

export const OTHER = "other";

export interface InputReply {
  type: string;
  ok: boolean;
  code?: string;
  reason?: string;
  leaseId?: string;
  interactId?: string;
  leaseMs?: number;
  renewMs?: number;
}

export interface Prepared {
  challenge: InputReply;
  start?: Record<string, unknown>;
}

export interface InteractState {
  lease: { leaseId: string; interactId: string; linkId: string; seq: number } | null;
  claim: string | null;
  stats: { started: number; refused: Record<string, number>; revoked: Record<string, number> };
}

export interface Session {
  lease?: InputReply;
  seq: number;
  pushes: { type: string; leaseId: string; reason: string }[];
  renewing: boolean;
  state?: string;
}

export const interactStart = (page: Page, url: string, name = NAME) =>
  call<InputReply>(page, "interactStart", name, url);
export const prepare = (page: Page, url: string, overrides = {}, name = NAME) =>
  call<Prepared>(page, "interactPrepare", name, url, overrides);
export const sendStart = (page: Page, start: unknown, name = NAME) =>
  call<InputReply>(page, "interactSend", name, start);
export const raw = (page: Page, message: unknown, name = NAME) =>
  call<InputReply>(page, "interactRaw", name, message);
export const stopInteract = (page: Page, name = NAME) =>
  call<InputReply>(page, "interactStop", name);
export const session = (page: Page, name = NAME) => call<Session>(page, "interactSession", name);
export const interactState = (worker: LoadedExtension) =>
  background<InteractState>(worker, "lab.interact.state()");

/** Waits until the worker holds no lease and no claim. */
export const released = (worker: LoadedExtension) =>
  until(
    () => interactState(worker),
    (state) => !state.lease && !state.claim,
    5_000,
  );

/** The page's signed start with its signature removed, for a re-sign or an unsigned send. */
export const unsigned = (start: Record<string, unknown>) => {
  const { signature: _signature, ...fields } = start;
  return fields;
};
