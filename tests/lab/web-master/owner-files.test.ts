import { describe, expect, test } from "vite-plus/test";
import {
  ensureMarker,
  pickFolder,
  readFile,
  readMarker,
  removeFile,
  writeFile,
} from "./site/owner-files.js";
import type { FolderHandle } from "./site/owner-files.js";

/* The FSA calls of the owner page, against an in-memory folder: absence is classified per operation. */

const fail = (name: string) => new DOMException(name, name);

interface Fake {
  files: Map<string, string>;
  gone: boolean;
  denied: boolean;
}

const folder = (state: Fake, prefix = ""): FolderHandle =>
  ({
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
      if (state.denied) throw fail("NotAllowedError");
      if (state.gone) throw fail("NotFoundError");
      const path = `${prefix}${name}/`;
      const known = [...state.files.keys()].some((key) => key.startsWith(path));
      if (!known && !options?.create) throw fail("NotFoundError");
      return folder(state, path);
    },
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (state.denied) throw fail("NotAllowedError");
      if (state.gone) throw fail("NotFoundError");
      const path = `${prefix}${name}`;
      if (!state.files.has(path) && !options?.create) throw fail("NotFoundError");
      return {
        getFile: async () => ({
          arrayBuffer: async () => new TextEncoder().encode(state.files.get(path)).buffer,
        }),
        createWritable: async () => ({
          write: async (bytes: Uint8Array) =>
            void state.files.set(path, new TextDecoder().decode(bytes)),
          close: async () => undefined,
        }),
      };
    },
    removeEntry: async (name: string) => {
      if (!state.files.delete(`${prefix}${name}`)) throw fail("NotFoundError");
    },
    values: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (state.gone) throw fail("NotFoundError");
          return { done: true, value: undefined };
        },
      }),
    }),
  }) as unknown as FolderHandle;

const make = (files: Record<string, string> = {}) => {
  const state: Fake = { files: new Map(Object.entries(files)), gone: false, denied: false };
  return { state, root: folder(state) };
};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("readFile", () => {
  test("reads the bytes at a nested path", async () => {
    const { root } = make({ "launcher/heartbeat": "beat" });
    const read = await readFile(root, "launcher/heartbeat");
    expect(read.status).toBe("ok");
    expect(read.status === "ok" && text(read.bytes)).toBe("beat");
  });

  test("an absent file under a present folder is missing, not a missing folder", async () => {
    const { root } = make({ "other/x": "1" });
    expect((await readFile(root, "launcher/heartbeat")).status).toBe("missing");
    expect((await readFile(root, "status/abc")).status).toBe("missing");
  });

  test("only a vanished root is a missing folder", async () => {
    const { root, state } = make();
    state.gone = true;
    expect((await readFile(root, "launcher/heartbeat")).status).toBe("folder-missing");
  });

  test("a revoked permission is denied", async () => {
    const { root, state } = make();
    state.denied = true;
    expect((await readFile(root, "launcher/heartbeat")).status).toBe("denied");
  });

  test("an unexpected error is reported with its message", async () => {
    const root = {
      getDirectoryHandle: async () => {
        throw new Error("boom");
      },
    } as unknown as FolderHandle;
    expect(await readFile(root, "a/b")).toEqual({ status: "error", message: "boom" });
  });
});

describe("writeFile and removeFile", () => {
  test("creates the folders and the file", async () => {
    const { root, state } = make();
    expect(
      (await writeFile(root, "exchange/w1/offer-1.json", new TextEncoder().encode("{}"))).status,
    ).toBe("ok");
    expect(state.files.get("exchange/w1/offer-1.json")).toBe("{}");
  });

  test("a denied write is denied", async () => {
    const { root, state } = make();
    state.denied = true;
    expect((await writeFile(root, "a/b", new Uint8Array())).status).toBe("denied");
  });

  test("removing an absent file is missing", async () => {
    const { root } = make({ "requests/a.req": "x" });
    expect((await removeFile(root, "requests/a.req")).status).toBe("ok");
    expect((await removeFile(root, "requests/a.req")).status).toBe("missing");
  });
});

describe("readMarker", () => {
  const id = "0b9f7a52-3c1e-4d0a-9a55-6f2f1c7b8e10";
  test("a valid marker names the workspace", async () => {
    const { root } = make({ "recnrun-workspace.json": JSON.stringify({ v: 1, workspaceId: id }) });
    expect(await readMarker(root)).toEqual({ marker: "ok", workspaceId: id });
  });

  test("a missing, malformed or wrong marker is told apart from a missing folder", async () => {
    expect((await readMarker(make().root)).marker).toBe("missing");
    expect((await readMarker(make({ "recnrun-workspace.json": "nope" }).root)).marker).toBe(
      "invalid",
    );
    const wrong = JSON.stringify({ v: 1, workspaceId: "../x" });
    expect((await readMarker(make({ "recnrun-workspace.json": wrong }).root)).marker).toBe(
      "invalid",
    );
    const { root, state } = make();
    state.gone = true;
    expect((await readMarker(root)).marker).toBe("folder-missing");
  });
});

describe("ensureMarker", () => {
  const id = "0b9f7a52-3c1e-4d0a-9a55-6f2f1c7b8e10";
  test("a picked folder without a marker gets the one the launcher reads", async () => {
    const { root, state } = make();
    const made = await ensureMarker(root);
    expect(made.marker).toBe("ok");
    const written = JSON.parse(state.files.get("recnrun-workspace.json") ?? "null");
    expect(written).toEqual({ v: 1, workspaceId: made.workspaceId });
    // launcher-request.sh workspace_id reads the id with this sed pattern.
    expect(state.files.get("recnrun-workspace.json")).toMatch(/"workspaceId": *"[0-9a-f-]{36}"/);
  });

  test("an existing marker is kept, so the launcher's workspace stays the same", async () => {
    const marker = JSON.stringify({ v: 1, workspaceId: id });
    const { root, state } = make({ "recnrun-workspace.json": marker });
    expect(await ensureMarker(root)).toEqual({ marker: "ok", workspaceId: id });
    expect(state.files.get("recnrun-workspace.json")).toBe(marker);
  });

  test("a denied folder is not written", async () => {
    const { root, state } = make();
    state.denied = true;
    expect((await ensureMarker(root)).marker).not.toBe("ok");
    expect(state.files.size).toBe(0);
  });
});

describe("pickFolder", () => {
  test("a cancelled picker keeps the current state", async () => {
    const cancel = async () => {
      throw fail("AbortError");
    };
    expect(await pickFolder(cancel)).toBeNull();
  });

  test("other picker errors surface", async () => {
    const broken = async () => {
      throw fail("SecurityError");
    };
    await expect(pickFolder(broken)).rejects.toThrow();
  });

  test("a picked handle is returned", async () => {
    const handle = { name: "workspace" };
    expect(await pickFolder(async () => handle)).toBe(handle);
  });
});
