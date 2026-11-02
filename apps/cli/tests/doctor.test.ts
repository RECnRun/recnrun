import { readFile } from "node:fs/promises";
import { parseDoctorReport } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import {
  assembleReport,
  doctorExitCode,
  formatReport,
  type DoctorProbes,
  type HealthProbe,
} from "@/doctor";
import { REQUIRED_NODE, satisfiesNode } from "@/node-version";
import { CLI_VERSION } from "@/version";

const found: HealthProbe["chrome"] = {
  ok: true,
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
  userDataDir: "/chrome",
  source: "active-port-file",
  port: 9222,
  path: "/devtools/browser/abc",
};
const missing: HealthProbe["chrome"] = {
  ok: false,
  code: "missing-file",
  remedy: "Enable remote debugging at chrome://inspect/#remote-debugging and keep Chrome open.",
  userDataDir: "/chrome",
};
const binding = (name: string, wsEndpoint: string) => ({ name, wsEndpoint });

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: "22.22.2",
    health: async () => ({ serviceVersion: "0.0.0", chrome: found }),
    bindingsPath: "/home/.recnrun/bindings.json",
    readBindings: async () => [],
    diskPath: "/home/.recnrun",
    disk: async () => ({ freeBytes: 5000, totalBytes: 10_000 }),
    ...overrides,
  };
}

test("a machine with Chrome and no bindings is ok, and the report is a valid DoctorReport", async () => {
  const report = await assembleReport(probes());
  expect(parseDoctorReport(report).ok).toBe(true);
  expect(report).toMatchObject({
    ok: true,
    node: { version: "22.22.2", required: REQUIRED_NODE, satisfies: true },
    remoteDebugging: { state: "found", path: "/chrome/DevToolsActivePort" },
    bindings: { count: 0, stale: [] },
    disk: { freeBytes: 5000, totalBytes: 10_000 },
    versions: { cli: CLI_VERSION, service: "0.0.0", protocol: 1 },
  });
  expect(doctorExitCode(report)).toBe(0);
});

test("no Chrome is not ok, reports not-found, and every binding is stale", async () => {
  const report = await assembleReport(
    probes({
      health: async () => ({ serviceVersion: "0.0.0", chrome: missing }),
      readBindings: async () => [binding("Ana", found.ok ? found.wsEndpoint : "")],
    }),
  );
  expect(report).toMatchObject({
    ok: false,
    chrome: { code: "missing-file" },
    remoteDebugging: { state: "not-found" },
    bindings: { count: 1, stale: ["Ana"] },
  });
  expect(doctorExitCode(report)).toBe(1);
});

test.each([
  ["malformed-file", "malformed"],
  ["stale-file", "stale"],
] as const)("a %s discovery is reported as %s", async (code, state) => {
  const report = await assembleReport(
    probes({ health: async () => ({ serviceVersion: "0.0.0", chrome: { ...missing, code } }) }),
  );
  expect(report.remoteDebugging.state).toBe(state);
});

test("a binding at another endpoint is stale and one at the current endpoint is fresh", async () => {
  const report = await assembleReport(
    probes({
      readBindings: async () => [
        binding("fresh", "ws://127.0.0.1:9222/devtools/browser/abc"),
        binding("old", "ws://127.0.0.1:9222/devtools/browser/zzz"),
      ],
    }),
  );
  expect(report.bindings).toMatchObject({ count: 2, stale: ["old"] });
});

test("an unreadable bindings file is reported with its reason, not thrown", async () => {
  const report = await assembleReport(
    probes({
      readBindings: async () => {
        throw new Error("not JSON");
      },
    }),
  );
  expect(report.bindings).toMatchObject({ count: 0, stale: [], error: "not JSON" });
});

test("a Node older than the engines range does not satisfy it", async () => {
  const report = await assembleReport(probes({ nodeVersion: "20.11.0" }));
  expect(report.node.satisfies).toBe(false);
});

test.each([
  ["22.18.0", true],
  ["22.22.2", true],
  ["24.1.0", true],
  ["22.17.9", false],
  ["18.20.0", false],
])("Node %s against the engines range is %s", (version, expected) => {
  expect(satisfiesNode(version, ">=22.18.0")).toBe(expected);
});

test("REQUIRED_NODE and CLI_VERSION match package.json", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string; engines: { node: string } };
  expect(REQUIRED_NODE).toBe(manifest.engines.node);
  expect(CLI_VERSION).toBe(manifest.version);
});

test("the human report is aligned lines naming each check and the remedy", async () => {
  const lines = formatReport(
    await assembleReport(
      probes({ health: async () => ({ serviceVersion: "0.0.0", chrome: missing }) }),
    ),
  );
  const labels = lines.map((line) => line.split(":")[0]);
  expect(labels).toEqual(
    expect.arrayContaining(["Node", "Chrome", "Remote debugging", "Bindings", "Disk", "Versions"]),
  );
  const columns = new Set(
    lines
      .filter((line) => /^\S/.test(line))
      .map((line) => /^[^:]+: +/.exec(line)?.[0].length ?? -1),
  );
  expect(columns.size).toBe(1);
  expect(lines.join("\n")).toContain("chrome://inspect/#remote-debugging");
});
