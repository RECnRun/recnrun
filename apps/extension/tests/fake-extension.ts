import type { RecordingSession } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import type { RecordingStore } from "@/ports/recording-store";
import type { ExtensionServices } from "@/views/extension-services";
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

/** The extension's services for a page under test: the sample recordings, two tabs, incognito allowed. */
export function fakeExtension(overrides: Partial<ExtensionServices> = {}): ExtensionServices {
  return {
    loadSnapshot: async () => sampleSnapshot(),
    recordings: memoryRecordingStore(),
    tabs: fakeTabs({ tabs: [SHOP, DOCS] }).source,
    incognito: fakeIncognito(true).access,
    holdSitePorts: () => {},
    send: async () => ({ ok: true }),
    ...overrides,
  };
}
