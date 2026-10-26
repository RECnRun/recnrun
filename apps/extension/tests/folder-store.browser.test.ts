import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { chooseFolder, folderAccess, loadFolder, pickFolder } from "@/p2p/folder-store";

/** A fresh folder in the origin private file system, standing in for the one the user picks. */
async function privateFolder(name: string) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(name, { recursive: true }).catch(() => {});
  return root.getDirectoryHandle(name, { create: true });
}

const names = async (folder: FileSystemDirectoryHandle) => {
  const found: string[] = [];
  for await (const name of folder.keys()) found.push(name);
  return found.toSorted();
};

beforeEach(async () => {
  await new Promise((resolve) => {
    indexedDB.deleteDatabase("recnrun-p2p").onsuccess = resolve;
  });
});

describe("chooseFolder", () => {
  test("keeps the chosen folder, with its pairing and recordings folders", async () => {
    expect(await loadFolder()).toBeUndefined();
    expect(await folderAccess(undefined)).toBe("none");
    const picked = await privateFolder("RECnRun");
    await chooseFolder(async () => picked);
    expect(await names(picked)).toEqual(["pairing", "recordings"]);
    const loaded = await loadFolder();
    expect(await loaded?.isSameEntry(picked)).toBe(true);
    expect(await folderAccess(loaded)).toBe("granted");
  });
});

describe("folderAccess", () => {
  test.each(["prompt", "denied"] as const)("asks again when Chrome answers %s", async (state) => {
    const folder = { queryPermission: vi.fn(async () => state) };
    expect(await folderAccess(folder as unknown as FileSystemDirectoryHandle)).toBe("prompt");
    expect(folder.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });
});

describe("pickFolder", () => {
  test("asks for a read-write folder under a stable id, starting in Documents", async () => {
    const folder = await privateFolder("picked");
    const page = {
      showDirectoryPicker: vi.fn(function (this: unknown) {
        // The picker throws an illegal invocation unless called on its window.
        if (this !== page) throw new TypeError("Illegal invocation");
        return Promise.resolve(folder);
      }),
    };
    expect(await pickFolder(page as unknown as Window)).toBe(folder);
    expect(page.showDirectoryPicker).toHaveBeenCalledWith({
      id: "recnrun-folder",
      mode: "readwrite",
      startIn: "documents",
    });
  });

  test("refuses a browser without the picker", async () => {
    await expect(pickFolder({} as Window)).rejects.toThrow(
      "This browser cannot share a folder with a page.",
    );
  });
});
