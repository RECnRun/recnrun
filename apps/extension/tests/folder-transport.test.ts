import { describe, expect, test } from "vite-plus/test";
import { folderTransport } from "@/p2p/folder-store";
import { ME } from "./fake-peer";
import { MemoryDirectory } from "./memory-directory";

const BOOT = "66666666-6666-4666-8666-666666666666";

const over = (chosen: MemoryDirectory | undefined) =>
  folderTransport({
    me: ME,
    boot: BOOT,
    load: async () => chosen as unknown as FileSystemDirectoryHandle | undefined,
  });

describe("folderTransport", () => {
  test.each([
    ["granted", true],
    ["prompt", false],
  ] as const)("works only while Chrome grants the folder: %s", async (permission, available) => {
    const chosen = new MemoryDirectory();
    chosen.permission = permission;
    const transport = over(chosen);
    expect(transport.kind).toBe("folder");
    expect(await transport.available()).toBe(available);
  });

  test("before a folder is chosen it is unavailable, and a look says why", async () => {
    const transport = over(undefined);
    expect(await transport.available()).toBe(false);
    await expect(transport.look()).rejects.toThrow("Choose the RECnRun folder first.");
  });

  test("lists no catalog peers, since the folder has no launcher", async () => {
    expect(await over(new MemoryDirectory()).discover()).toEqual([]);
  });
});
