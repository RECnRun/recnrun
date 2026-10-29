import type { IdentityCapture } from "@recnrun/domain";
import { vi } from "vite-plus/test";
import type { SessionWindow } from "@/background/workspace/capture-api";
import type { CapturePart } from "@/storage/identity-captures";
import { fakeCookieApi } from "./fake-cookies";
import { noVisits } from "./fake-helper";
import { echoProbes, fakeEvent, fakePort } from "./fake-port";

const ORIGIN = "http://app.localhost:5192";
const SENDER = { tab: { id: 7 }, frameId: 0, documentId: "doc-1", origin: ORIGIN };
const URL_ = `${ORIGIN}/app/`;

/**
 * Chrome as a capture sees it: one window holding tab 7, a tab's top document, an agent that connects when injected and
 * echoes the link probe as `carry` delivers it, and the Incognito cookie store holding tab 7.
 */
export function chrome(
  frame: { url: string; documentId: string } | null = { url: URL_, documentId: "doc-1" },
  carry?: (probe: unknown) => unknown,
) {
  const onConnect = fakeEvent<[ReturnType<typeof fakePort>]>();
  const agent = echoProbes(fakePort(SENDER), carry);
  const api = {
    onConnect,
    settle: vi.fn(async (_boundMs: number) => undefined),
    // One window, its one tab the managed tab 7, unless a test lays out more.
    windows: vi.fn(async (): Promise<SessionWindow[]> => [
      { id: 9, focused: true, tabs: [{ id: 7, active: true }] },
    ]),
    topFrame: vi.fn(async (_tabId: number) => frame),
    inject: vi.fn(async () => onConnect.emit(agent)),
    // A discard keeps the tab's id, as Chrome's in-place discard does.
    discard: vi.fn(async (tabId: number) => tabId),
    navigate: vi.fn(async (_tabId: number, _url: string) => undefined),
  };
  const cookies = fakeCookieApi(
    [
      [
        { id: "0", tabIds: [1] },
        { id: "1", tabIds: [7] },
      ],
    ],
    [1],
  );
  return { api, agent, onConnect, cookies, origins: noVisits() };
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
    dropParts: vi.fn(async (_id: string, origin: string) => {
      calls.push("drop");
      parts.splice(0, parts.length, ...parts.filter((part) => part.origin !== origin));
    }),
    publish: vi.fn(async (header: IdentityCapture) => {
      calls.push("publish");
      headers.push(header);
    }),
    discard: vi.fn(async () => {
      calls.push("discard");
    }),
    read: vi.fn(async (_identityId: string): Promise<IdentityCapture | null> => null),
    settle: vi.fn(async (_identityId: string, _committedId: string | undefined) => {
      calls.push("settle");
    }),
    remove: vi.fn(async () => {
      calls.push("remove");
    }),
  };
}
