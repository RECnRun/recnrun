import { describe, expect, test, vi } from "vite-plus/test";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import { folderSignaling, pickFolder, signalFileOf } from "@/pairing/folder-signaling";
import type { SignalFile } from "@/pairing/folder-signaling";
import { ME, PEER, STRANGER } from "./fake-peer";

type Directory = Parameters<typeof folderSignaling>[0];

const NOW = 1_700_000_000_000;
const PAIRING = "44444444-4444-4444-8444-444444444444";
const OTHER_PAIRING = "55555555-5555-4555-8555-555555555555";

const notFound = () => new DOMException("Not found", "NotFoundError");

/** The parts of the File System Access API the signaling uses; a write lands only on close. */
class MemoryDirectory {
  readonly folders = new Map<string, MemoryDirectory>();
  readonly files = new Map<string, string>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let folder = this.folders.get(name);
    if (!folder && (this.files.has(name) || !options?.create)) throw notFound();
    folder ??= new MemoryDirectory();
    this.folders.set(name, folder);
    return folder;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && !options?.create) throw notFound();
    let pending = this.files.get(name) ?? "";
    return {
      getFile: async () => new File([this.files.get(name) ?? ""], name),
      createWritable: async () => ({
        write: async (data: string) => void (pending = data),
        close: async () => void this.files.set(name, pending),
      }),
    };
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.folders.delete(name)) throw notFound();
  }

  async *keys() {
    yield* [...this.folders.keys(), ...this.files.keys()];
  }

  folder(...path: string[]): MemoryDirectory {
    return path.reduce<MemoryDirectory>((at, name) => {
      const next = at.folders.get(name) ?? new MemoryDirectory();
      at.folders.set(name, next);
      return next;
    }, this);
  }
}

function signal(overrides: Partial<SignalFile> = {}): SignalFile {
  return {
    kind: "offer",
    pairingId: PAIRING,
    profileId: PEER,
    expiresAt: NOW + PAIRING_TTL_MS,
    code: "RECNRUN-PAIR-1.code",
    ...overrides,
  };
}

/** A shared folder, the signaling of this profile over it, and a way to drop a peer's file in. */
function sharedFolder() {
  const picked = new MemoryDirectory();
  const signaling = folderSignaling(picked as unknown as Directory, ME, () => NOW);
  const root = () => picked.folder("recnrun-signaling");
  const drop = (owner: string, name: string, content: unknown) =>
    root()
      .folder(owner)
      .files.set(name, typeof content === "string" ? content : JSON.stringify(content));
  return { picked, signaling, root, drop };
}

describe("signalFileOf", () => {
  test("names the file from the code's own fields", () => {
    const pairing = {
      kind: "answer" as const,
      pairingId: PAIRING,
      profileId: ME,
      displayName: "Laptop",
      expiresAt: NOW + PAIRING_TTL_MS,
      sdp: "v=0\r\n",
    };
    const code = encodePairing(pairing);
    expect(signalFileOf(code, NOW)).toEqual({
      kind: "answer",
      pairingId: PAIRING,
      profileId: ME,
      expiresAt: pairing.expiresAt,
      code,
    });
    expect(() => signalFileOf(code, pairing.expiresAt)).toThrow("expired");
  });
});

describe("publish", () => {
  test("writes the signal into this profile's own subfolder, whole", async () => {
    const { signaling, root } = sharedFolder();
    const mine = signal({ profileId: ME });
    await signaling.publish(mine);
    expect([...root().folders.keys()]).toEqual([ME]);
    const stored = root().folder(ME).files.get(`offer-${PAIRING}.json`);
    expect(JSON.parse(stored ?? "null")).toEqual(mine);
  });
});

describe("find", () => {
  test("finds the other profile's signal of the asked kind and pairing", async () => {
    const { signaling, drop } = sharedFolder();
    const answer = signal({ kind: "answer", pairingId: OTHER_PAIRING });
    drop(PEER, `answer-${OTHER_PAIRING}.json`, answer);
    expect(await signaling.find("answer", OTHER_PAIRING)).toEqual(answer);
    expect(await signaling.find("answer")).toEqual(answer);
    expect(await signaling.find("answer", PAIRING)).toBeUndefined();
    expect(await signaling.find("offer")).toBeUndefined();
  });

  test("never reads this profile's own folder", async () => {
    const { signaling, drop } = sharedFolder();
    drop(ME, `offer-${PAIRING}.json`, signal({ profileId: ME }));
    expect(await signaling.find("offer")).toBeUndefined();
  });

  test.each([
    ["owned by another profile than its folder", signal({ profileId: STRANGER })],
    ["expired", signal({ expiresAt: NOW })],
    ["not JSON", "{not json"],
    ["not a signal", { ...signal(), extra: true }],
    ["oversized", JSON.stringify(signal()).padEnd(128 * 1024 + 1)],
  ])("ignores a file that is %s and reads on", async (_, content) => {
    const { signaling, drop } = sharedFolder();
    drop(PEER, `offer-${PAIRING}.json`, content);
    expect(await signaling.find("offer")).toBeUndefined();
    const valid = signal({ profileId: STRANGER, pairingId: OTHER_PAIRING });
    drop(STRANGER, `offer-${OTHER_PAIRING}.json`, valid);
    expect(await signaling.find("offer")).toEqual(valid);
  });

  test("ignores names it does not write and folders that are not profiles", async () => {
    const { signaling, drop, root } = sharedFolder();
    drop(PEER, `offer-${PAIRING}.json.bak`, signal());
    drop(PEER, "offer-not-a-uuid.json", signal());
    drop("not-a-profile", `offer-${PAIRING}.json`, signal());
    root().files.set(STRANGER, "a file where a folder would be");
    const opened = vi.spyOn(root(), "getDirectoryHandle");
    expect(await signaling.find("offer")).toBeUndefined();
    expect(opened.mock.calls.map(([name]) => name)).toEqual([PEER, STRANGER]);
  });
});

describe("clean", () => {
  function folderWithFiles() {
    const shared = sharedFolder();
    const { drop } = shared;
    drop(ME, `offer-${PAIRING}.json`, signal({ profileId: ME }));
    drop(ME, `answer-${PAIRING}.json`, signal({ kind: "answer", profileId: ME, expiresAt: NOW }));
    drop(ME, `offer-${OTHER_PAIRING}.json`, "{damaged");
    drop(ME, "notes.txt", "kept");
    drop(PEER, `offer-${PAIRING}.json`, signal({ expiresAt: NOW }));
    const names = (owner: string) => [...shared.root().folder(owner).files.keys()];
    return { ...shared, names };
  }

  test("removes only this profile's expired or unreadable files", async () => {
    const { signaling, names } = folderWithFiles();
    await signaling.clean(false);
    expect(names(ME)).toEqual([`offer-${PAIRING}.json`, "notes.txt"]);
    expect(names(PEER)).toEqual([`offer-${PAIRING}.json`]);
  });

  test("removes every signal file of this profile when the pairing ends", async () => {
    const { signaling, names } = folderWithFiles();
    await signaling.clean(true);
    expect(names(ME)).toEqual(["notes.txt"]);
    expect(names(PEER)).toEqual([`offer-${PAIRING}.json`]);
  });
});

describe("pickFolder", () => {
  test("asks the page for a read-write folder under a stable id", async () => {
    const folder = new MemoryDirectory();
    const page = {
      showDirectoryPicker: vi.fn(function (this: unknown) {
        // The picker throws an illegal invocation unless called on its window.
        if (this !== page) throw new TypeError("Illegal invocation");
        return Promise.resolve(folder);
      }),
    };
    expect(await pickFolder(page as unknown as Window)).toBe(folder);
    expect(page.showDirectoryPicker).toHaveBeenCalledWith({
      id: "recnrun-signaling",
      mode: "readwrite",
    });
  });

  test("refuses a browser without the picker", async () => {
    await expect(pickFolder({} as Window)).rejects.toThrow(
      "This browser cannot share a folder with a page.",
    );
  });
});
