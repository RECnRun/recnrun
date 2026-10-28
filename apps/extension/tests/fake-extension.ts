import type { RecordingSession } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import type { WorkspaceStatus } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { ExtensionServices, PageRequest, SendRequest } from "@/views/extension-services";
import { memoryOperationJournal } from "./fake-journal";
import { DOCS, SHOP, fakeIncognito, fakeTabs } from "./fake-tabs";

/** Stands in for extension session storage; every view given the same store sees each write. */
export function memoryRecordingStore(
  initial: RecordingSession | null = null,
  unreadable = false,
): RecordingStore {
  let session = initial;
  const listeners = new Set<() => void>();
  return {
    read: async () => {
      if (unreadable) throw new Error("Stored session is invalid");
      return session;
    },
    write: async (next) => {
      session = next;
      for (const listener of listeners) listener();
    },
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

/** With access and no Incognito window open, the workspace offers Start. */
export const NO_INCOGNITO_WINDOW: WorkspaceStatus = {
  available: true,
  access: true,
  foreign: [],
  busy: false,
  identities: [],
};

/**
 * A background that answers `workspace-status` with `status()` and accepts every other request,
 * which it keeps in `sent`.
 */
export function fakeBackground(status: () => WorkspaceStatus = () => NO_INCOGNITO_WINDOW) {
  const sent: PageRequest[] = [];
  const send: SendRequest = async (request) => {
    if (request.type === "workspace-status") return { ok: true, result: status() };
    sent.push(request);
    return { ok: true };
  };
  return { send, sent };
}

/** The extension's services for a page under test: the sample recordings, two tabs, incognito allowed. */
export function fakeExtension(overrides: Partial<ExtensionServices> = {}): ExtensionServices {
  return {
    loadSnapshot: async () => sampleSnapshot(),
    recordings: memoryRecordingStore(),
    tabs: fakeTabs({ tabs: [SHOP, DOCS] }).source,
    incognito: fakeIncognito(true).access,
    operations: memoryOperationJournal(),
    holdSitePorts: () => {},
    send: fakeBackground().send,
    ...overrides,
  };
}
