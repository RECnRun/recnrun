import type { IdentityCapture } from "@recnrun/domain";
import { vi } from "vite-plus/test";
import type { CapturePart } from "@/storage/identity-captures";
import { fakeEvent, fakePort } from "./fake-port";

const ORIGIN = "http://app.localhost:5192";
const SENDER = { tab: { id: 7 }, frameId: 0, documentId: "doc-1", origin: ORIGIN };
const URL_ = `${ORIGIN}/app/`;

/** Chrome as a capture sees it: a tab's top document, and an agent that connects when injected. */
export function chrome(
  frame: { url: string; documentId: string } | null = { url: URL_, documentId: "doc-1" },
) {
  const onConnect = fakeEvent<[ReturnType<typeof fakePort>]>();
  const agent = fakePort(SENDER);
  const api = {
    onConnect,
    topFrame: vi.fn(async () => frame),
    inject: vi.fn(async () => onConnect.emit(agent)),
  };
  return { api, agent, onConnect };
}

/** A repository that keeps what it was told, in order. */
export function memoryCaptures() {
  const calls: string[] = [];
  const parts: CapturePart[] = [];
  const headers: IdentityCapture[] = [];
  return {
    calls,
    parts,
    headers,
    begin: vi.fn(async (header: IdentityCapture) => {
      calls.push("begin");
      headers.push(header);
    }),
    append: vi.fn(async (_id: string, part: CapturePart) => {
      calls.push("append");
      parts.push(part);
    }),
    publish: vi.fn(async (header: IdentityCapture) => {
      calls.push("publish");
      headers.push(header);
    }),
    discard: vi.fn(async () => {
      calls.push("discard");
    }),
    read: vi.fn(async (_identityId: string): Promise<IdentityCapture | null> => null),
  };
}
