import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { clearLabDefault, labEnvironmentOn } from "./fixtures/e4-lab.ts";
import type { LabHost } from "./fixtures/e4-lab.ts";

// Codex P2 finding 1: E4's lab session removes a Downloads folder only inside the test container.
const HOME = "/root";
const NAMESPACE = join(HOME, "Downloads", "RECnRun", "poc", "lab");
const folder = { isSymbolicLink: () => false, isDirectory: () => true };
const link = { isSymbolicLink: () => true, isDirectory: () => false };

/** A container host whose `rm` records and then stops the session before any Chrome starts. */
function fakeHost(overrides: Partial<LabHost> = {}) {
  const host = {
    env: { RECNRUN_TEST_CONTAINER: "1", HOME },
    dockerenv: vi.fn(() => true),
    home: () => HOME,
    lstat: vi.fn(async () => folder),
    rm: vi.fn(async () => {
      throw new Error("stopped after the removal");
    }),
    ...overrides,
  };
  return host;
}

describe("E4 lab session guard", () => {
  test("refuses outside the test container before any filesystem call", async () => {
    const host = fakeHost({ env: { HOME } });
    await expect(labEnvironmentOn(host).session()).rejects.toThrow(/inside the test container/);
    expect(host.rm).not.toHaveBeenCalled();
    expect(host.lstat).not.toHaveBeenCalled();
    expect(host.dockerenv).not.toHaveBeenCalled();
  });

  test("refuses without Docker's /.dockerenv", async () => {
    const host = fakeHost({ dockerenv: vi.fn(() => false) });
    await expect(labEnvironmentOn(host).session()).rejects.toThrow(/inside the test container/);
    expect(host.rm).not.toHaveBeenCalled();
  });

  test("refuses a $HOME that is not the container user's home", async () => {
    const host = fakeHost({ env: { RECNRUN_TEST_CONTAINER: "1", HOME: "/Users/someone" } });
    await expect(labEnvironmentOn(host).session()).rejects.toThrow(/container user's/);
    expect(host.rm).not.toHaveBeenCalled();
  });

  test("refuses a Downloads root reached through a symbolic link", async () => {
    const lstat = vi.fn(async (path: string) => (path.endsWith("Downloads") ? link : folder));
    const host = fakeHost({ lstat });
    await expect(labEnvironmentOn(host).session()).rejects.toThrow(/symbolic link/);
    expect(host.rm).not.toHaveBeenCalled();
  });

  test("removes only the namespace folder under the container user's Downloads", async () => {
    const rm = vi.fn(async (_path: string) => undefined);
    await expect(clearLabDefault(fakeHost({ rm }))).resolves.toBe(join(HOME, "Downloads"));
    expect(rm.mock.calls).toEqual([[NAMESPACE]]);
  });
});
