import { expect, test } from "vite-plus/test";
import { parseDoctorReport, type DoctorReport } from "../src/index.ts";

const report: DoctorReport = {
  schemaVersion: 1,
  ok: false,
  node: { version: "22.22.2", required: ">=22.18.0", satisfies: true },
  chrome: {
    ok: false,
    code: "missing-file",
    remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
    userDataDir: "/nowhere",
  },
  remoteDebugging: { state: "not-found", path: "/nowhere/DevToolsActivePort" },
  bindings: { path: "/home/.recnrun/bindings.json", count: 1, stale: ["Ana"] },
  disk: { path: "/home/.recnrun", freeBytes: 1024, totalBytes: 4096 },
  versions: { cli: "0.0.0", service: "0.0.0", protocol: 1 },
};

test("accepts a report of a machine with no Chrome", () => {
  expect(parseDoctorReport(report)).toEqual({ ok: true, value: report });
});

test("accepts a bindings file that cannot be read, with its reason", () => {
  const broken = { ...report, bindings: { ...report.bindings, error: "not JSON" } };
  expect(parseDoctorReport(broken).ok).toBe(true);
});

test.each([
  ["an unknown field", { extra: true }],
  ["a negative free space", { disk: { path: "/", freeBytes: -1, totalBytes: 1 } }],
  ["an unknown remote debugging state", { remoteDebugging: { state: "maybe" } }],
  [
    "a protocol version this build does not read",
    { versions: { ...report.versions, protocol: 9 } },
  ],
])("rejects %s", (_name, change) => {
  const parsed = parseDoctorReport({ ...report, ...change });
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.message).not.toBe("");
});
