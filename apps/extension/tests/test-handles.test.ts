import type { IdentityData } from "@recnrun/domain";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { installTestHandles } from "@/background/test-handles";
import type { PocHandles } from "@/background/test-handles";
import type { BootstrapHooks } from "@/background/workspace/bootstrap";
import type { WorkspaceCommands } from "@/background/workspace/commands";

const DATA: IdentityData = {
  cookies: [],
  site: { localStorage: {}, sessionStorage: {}, indexedDB: [] },
};
const TIMINGS = [{ step: "window" as const, ms: 2 }];
const SUMMARY = { captureId: "capture-1", databases: 1, records: 3, ms: 12 };

function install() {
  const scope: { recnrunPoc?: PocHandles } = {};
  const startWithIdentity = vi.fn(async () => TIMINGS);
  const captureIdentity = vi.fn(async () => SUMMARY);
  const startFromCapture = vi.fn(async () => TIMINGS);
  const commands = {
    startWithIdentity,
    captureIdentity,
    startFromCapture,
  } as unknown as WorkspaceCommands;
  const hooks: BootstrapHooks = { beforeStep: async () => {} };
  installTestHandles(scope, commands, hooks);
  if (!scope.recnrunPoc) throw new Error("No handles installed");
  return { handles: scope.recnrunPoc, hooks, startWithIdentity, captureIdentity, startFromCapture };
}

afterEach(() => {
  vi.useRealTimers();
});

test("starts with validated identity data and keeps the step timings", async () => {
  const { handles, startWithIdentity } = install();
  await expect(handles.startWithIdentity("http://app.localhost:5192/app/", DATA)).resolves.toEqual(
    TIMINGS,
  );
  expect(startWithIdentity).toHaveBeenCalledWith("http://app.localhost:5192/app/", DATA);
  expect(handles.timings()).toEqual([TIMINGS]);
  await expect(handles.startWithIdentity("http://app.localhost:5192/", {})).rejects.toThrow();
  expect(startWithIdentity).toHaveBeenCalledTimes(1);
});

test("delays the restore step only, by the set delay", async () => {
  vi.useFakeTimers();
  const { handles, hooks } = install();
  handles.setRestoreDelay(2_000);
  await expect(hooks.beforeStep("window")).resolves.toBeUndefined();
  let restored = false;
  const restore = hooks.beforeStep("restore").then(() => {
    restored = true;
  });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(restored).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await restore;
  expect(restored).toBe(true);
});

test("fails the next run of one step once", async () => {
  const { handles, hooks } = install();
  handles.failNext("restore");
  await expect(hooks.beforeStep("navigate")).resolves.toBeUndefined();
  await expect(hooks.beforeStep("restore")).rejects.toMatchObject({ name: "InjectedFailure" });
  await expect(hooks.beforeStep("restore")).resolves.toBeUndefined();
});

test("captures an identity and starts from its capture, keeping that start's timings", async () => {
  const { handles, captureIdentity, startFromCapture } = install();
  await expect(handles.captureIdentity("identity-a")).resolves.toEqual(SUMMARY);
  expect(captureIdentity).toHaveBeenCalledWith("identity-a");
  await expect(handles.startFromCapture("identity-a")).resolves.toEqual(TIMINGS);
  expect(startFromCapture).toHaveBeenCalledWith("identity-a");
  expect(handles.timings()).toEqual([TIMINGS]);
});
