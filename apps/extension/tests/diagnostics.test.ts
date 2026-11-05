import { describe, expect, test, vi } from "vite-plus/test";
import { ask, downloadMessages } from "@/diagnostics/poc-messages";
import { buildReport } from "@/diagnostics/report";
import { readBack, startDiagnostics } from "@/diagnostics/start";
import { fakeBrowser } from "wxt/testing/fake-browser";

const sources = (permissions: string[]) => ({
  extensionId: "abc",
  mode: "poc-d1",
  permissions,
  isAllowedFileSchemeAccess: async () => true,
  isAllowedIncognitoAccess: async () => false,
});

describe("buildReport", () => {
  test("keeps the keys and order the experiment specs read", async () => {
    const report = await buildReport(sources(["storage", "debugger"]));
    expect(Object.keys(report)).toEqual([
      "extensionId",
      "mode",
      "permissions",
      "fileSchemeAccess",
      "incognitoAccess",
      "debuggerDeclared",
    ]);
    expect(report).toMatchObject({ fileSchemeAccess: true, incognitoAccess: false });
    expect(report.debuggerDeclared).toBe(true);
  });

  test("reports no debugger when the permission is not declared", async () => {
    expect((await buildReport(sources(["storage"]))).debuggerDeclared).toBe(false);
  });
});

describe("the background replies", () => {
  test("returns a well-formed reply and sends the message with its options", async () => {
    const send = vi.fn(async () => ({ ok: true, result: { id: 3 } }));
    const reply = await downloadMessages(send).probe("lab", "{}", { settle: false });
    expect(reply).toEqual({ ok: true, result: { id: 3 } });
    expect(send).toHaveBeenCalledWith({
      type: "POC_DOWNLOAD_PROBE",
      namespace: "lab",
      content: "{}",
      settle: false,
    });
  });

  test("passes a failure reply through", async () => {
    const send = async () => ({ ok: false, error: "No download 1" });
    expect(await downloadMessages(send).search(1)).toEqual({ ok: false, error: "No download 1" });
  });

  test.each([undefined, null, "ok", { ok: "yes" }])(
    "rejects the malformed reply %j with a clear error",
    async (reply) => {
      const send = async () => reply;
      await expect(ask(send, { type: "POC_DOWNLOAD_CANCEL", id: 1 })).rejects.toThrow(
        "The background sent a malformed reply to POC_DOWNLOAD_CANCEL.",
      );
    },
  );
});

describe("readBack", () => {
  test("reads the file URL of an absolute path", async () => {
    const fetcher = vi.fn(async () => new Response("hello"));
    expect(await readBack("/tmp/a b.json", fetcher)).toEqual({
      ok: true,
      url: "file:///tmp/a%20b.json",
      text: "hello",
    });
  });

  test("answers a failed read or a relative path with the error", async () => {
    const failing = async () => Promise.reject(new Error("Failed to fetch"));
    expect(await readBack("/tmp/a", failing)).toEqual({ ok: false, error: "Failed to fetch" });
    expect(await readBack("relative")).toMatchObject({ ok: false });
  });
});

describe("startDiagnostics", () => {
  type Poc = Record<string, (...args: never[]) => unknown>;
  /** A page with the diagnostics element, or without one. */
  const pageWith = (element: { textContent: string } | null) => {
    const page = { document: { getElementById: vi.fn(() => element) } };
    return page as unknown as Window & typeof globalThis & { __poc?: Poc };
  };

  test("installs window.__poc and writes the report the experiments read", async () => {
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "RECnRun",
      version: "0.1.0",
      permissions: ["storage", "downloads"],
    });
    vi.spyOn(fakeBrowser.extension, "isAllowedFileSchemeAccess").mockResolvedValue(true as never);
    vi.spyOn(fakeBrowser.extension, "isAllowedIncognitoAccess").mockResolvedValue(false as never);
    const pre = { textContent: "" };
    const page = pageWith(pre);
    vi.stubGlobal("window", page);

    await startDiagnostics();
    vi.unstubAllGlobals();

    expect(Object.keys(page.__poc ?? {}).sort()).toEqual(
      [
        "cancel",
        "probe",
        "readBack",
        "readFile",
        "readPublication",
        "readRegistry",
        "renewCertificate",
        "search",
      ].sort(),
    );
    const { profile, ...legacy } = JSON.parse(pre.textContent);
    expect(profile).toMatchObject({
      extension: { id: fakeBrowser.runtime.id, version: "0.1.0", mode: "test" },
      templateMode: false,
      transport: { kind: "downloads", namespace: "lab", paused: null },
    });
    expect(legacy).toEqual({
      extensionId: fakeBrowser.runtime.id,
      mode: "test",
      permissions: ["storage", "downloads"],
      fileSchemeAccess: true,
      incognitoAccess: false,
      debuggerDeclared: false,
    });
  });

  test("reads a publication through the tolerant reader; a failed read counts as absent", async () => {
    vi.spyOn(fakeBrowser.extension, "isAllowedFileSchemeAccess").mockResolvedValue(false as never);
    vi.spyOn(fakeBrowser.extension, "isAllowedIncognitoAccess").mockResolvedValue(false as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const page = pageWith(null);

    await startDiagnostics(page);

    const readPublication = page.__poc?.readPublication as (
      path: string,
      previous: undefined,
    ) => Promise<unknown>;
    expect(await readPublication("/tmp/none.json", undefined)).toEqual({
      publication: undefined,
      reason: "absent",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("")),
    );
    expect(await readPublication("/tmp/empty.json", undefined)).toEqual({
      publication: undefined,
      reason: "empty",
    });
    vi.unstubAllGlobals();
  });
});
