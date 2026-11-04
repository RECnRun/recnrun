import { describe, expect, test, vi } from "vite-plus/test";
import { ask, downloadMessages } from "@/diagnostics/poc-messages";
import { buildReport } from "@/diagnostics/report";
import { readBack } from "@/diagnostics/start";

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
