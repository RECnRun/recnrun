import type { Identity, ManagedWindowState } from "@recnrun/domain";
import { vi } from "vite-plus/test";
import { WorkspaceError } from "@/background/workspace/errors";
import type { CaptureSummary } from "@/background/workspace/capture";
import type { LifecycleEffects } from "@/background/workspace/lifecycle-types";
import type { IdentityRepository } from "@/ports/identities";

export const identity = (id: string, captured = true): Identity => ({
  id,
  label: id.toUpperCase(),
  url: `https://${id}.example/`,
  capabilities: { cookieHosts: [] },
  created: 1,
  ...(captured && { lastCapture: { id: `cap-${id}`, at: 1, bytes: 10 } }),
});

/** Identities in memory; `failNext` makes the next change reject, as a full disk would. */
export function memoryIdentities(initial: Identity[] = []) {
  const memory = { saved: initial, failNext: false };
  const repository: IdentityRepository = {
    list: async () => memory.saved,
    update: async (change) => {
      if (memory.failNext) {
        memory.failNext = false;
        throw new Error("The disk is full.");
      }
      memory.saved = change(memory.saved);
      return memory.saved;
    },
  };
  return { memory, repository };
}

const NOTHING = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [], caches: [] },
};

const SUMMARY: CaptureSummary = {
  captureId: "",
  localStorage: 1,
  sessionStorage: 0,
  databases: 0,
  records: 0,
  caches: 0,
  cacheEntries: 0,
  cookies: 1,
  unsupported: 0,
  bytes: 64,
  ms: 1,
};

/** Chrome's side of each step, recorded; `failAt` makes that step throw. */
export function fakeEffects(open?: { identityId?: string }) {
  const calls: string[] = [];
  const window = (fields: object): ManagedWindowState => ({
    generation: 1,
    windowId: 5,
    tabId: 50,
    status: "active",
    ...fields,
  });
  const state = {
    managed: open ? window(open) : undefined,
    foreign: [] as number[],
    otherTabs: 0,
    failAt: undefined as string | undefined,
  };
  const fail = (step: string) => {
    if (state.failAt === step) throw new WorkspaceError("InjectedFailure", `Injected at ${step}.`);
  };
  const effects: LifecycleEffects = {
    windows: vi.fn(async () => ({
      managed: state.managed,
      foreign: state.foreign,
      otherTabs: state.otherTabs,
    })),
    capture: vi.fn(async (saved: Identity) => {
      calls.push(`capture ${saved.id}`);
      fail("capture");
      return { ...SUMMARY, captureId: `cap-${saved.id}-2` };
    }),
    close: vi.fn(async (ids: readonly number[]) => {
      calls.push(`close ${ids.join(",")}`);
      fail("close");
      if (state.managed && ids.includes(state.managed.windowId)) state.managed = undefined;
      state.foreign = state.foreign.filter((id) => !ids.includes(id));
    }),
    load: vi.fn(async (target: Identity, from: "capture" | "empty") => {
      fail("load");
      return { from, url: target.url, data: NOTHING };
    }),
    start: vi.fn(async (target: Identity, { from }: { from: "capture" | "empty" }) => {
      calls.push(`start ${target.id} ${from}`);
      fail("start");
      state.managed = window({ identityId: target.id });
      return [{ step: "reload" as const, ms: 1 }];
    }),
    removeCaptures: vi.fn(async (identityId: string) => {
      calls.push(`remove ${identityId}`);
    }),
    settle: vi.fn(async (_identityId: string, _committedId: string | undefined) => {}),
  };
  return { calls, state, effects };
}
