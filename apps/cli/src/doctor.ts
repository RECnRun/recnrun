import { join } from "node:path";
import {
  PROTOCOL_SCHEMA_VERSION,
  type DiscoveryResult,
  type DoctorReport,
} from "@recnrun/protocol";
import { REQUIRED_NODE, satisfiesNode } from "./node-version.ts";
import { CLI_VERSION } from "./version.ts";

/** What the service's `health` command tells that `doctor` needs. */
export interface HealthProbe {
  serviceVersion: string;
  chrome: DiscoveryResult;
}

/** The machine, injected so tests need no Chrome, service, or disk. */
export interface DoctorProbes {
  nodeVersion: string;
  health(): Promise<HealthProbe>;
  bindingsPath: string;
  readBindings(): Promise<{ name: string; wsEndpoint: string }[]>;
  diskPath: string;
  disk(): Promise<{ freeBytes: number; totalBytes: number }>;
}

const DISCOVERY_STATES = {
  "missing-file": "not-found",
  "malformed-file": "malformed",
  "stale-file": "stale",
  "unreadable-file": "unreadable",
} as const;

function remoteDebugging(chrome: DiscoveryResult): DoctorReport["remoteDebugging"] {
  const path = join(chrome.userDataDir, "DevToolsActivePort");
  return { state: chrome.ok ? "found" : DISCOVERY_STATES[chrome.code], path };
}

async function bindingsOf(
  probes: DoctorProbes,
  chrome: DiscoveryResult,
): Promise<DoctorReport["bindings"]> {
  const base = { path: probes.bindingsPath };
  try {
    const bindings = await probes.readBindings();
    // Only the default profile is probed, so a binding is stale when it differs from that endpoint.
    const stale = bindings
      .filter(({ wsEndpoint }) => !chrome.ok || wsEndpoint !== chrome.wsEndpoint)
      .map(({ name }) => name);
    return { ...base, count: bindings.length, stale };
  } catch (error) {
    return {
      ...base,
      count: 0,
      stale: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Gathers every check into one report; a failing check is reported in it, not thrown. */
export async function assembleReport(probes: DoctorProbes): Promise<DoctorReport> {
  const { serviceVersion, chrome } = await probes.health();
  const disk = await probes.disk();
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    ok: chrome.ok,
    node: {
      version: probes.nodeVersion,
      required: REQUIRED_NODE,
      satisfies: satisfiesNode(probes.nodeVersion, REQUIRED_NODE),
    },
    chrome,
    remoteDebugging: remoteDebugging(chrome),
    bindings: await bindingsOf(probes, chrome),
    disk: { path: probes.diskPath, ...disk },
    versions: { cli: CLI_VERSION, service: serviceVersion, protocol: PROTOCOL_SCHEMA_VERSION },
  };
}

/** 0 when Chrome was found, 1 when it was not; 2 (an error) never reaches a report. */
export const doctorExitCode = (report: DoctorReport): 0 | 1 => (report.ok ? 0 : 1);

const mebibytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MiB`;

/** The report as aligned `Label: value` lines, with the remedy under a failing Chrome. */
export function formatReport(report: DoctorReport): string[] {
  const { node, chrome, remoteDebugging: debugging, bindings, disk, versions } = report;
  const rows: [string, string][] = [
    ["Node", `${node.version} (needs ${node.required}): ${node.satisfies ? "ok" : "too old"}`],
    ["Chrome", chromeLine(chrome)],
    ["Remote debugging", `${debugging.state}${debugging.path ? ` (${debugging.path})` : ""}`],
    ["Bindings", bindingsLine(bindings)],
    ["Disk", `${mebibytes(disk.freeBytes)} free of ${mebibytes(disk.totalBytes)} (${disk.path})`],
    ["Versions", `cli ${versions.cli}, service ${versions.service}, protocol ${versions.protocol}`],
  ];
  if (!chrome.ok) rows.push(["Fix", chrome.remedy]);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width + 1)} ${value}`);
}

function chromeLine(chrome: DiscoveryResult): string {
  if (chrome.ok) return `found at ${chrome.wsEndpoint}`;
  // A blocked read says nothing about whether Chrome runs, so it is not "not found".
  return `${chrome.code === "unreadable-file" ? "blocked" : "not found"} (${chrome.code})`;
}

function bindingsLine({ count, stale, error, path }: DoctorReport["bindings"]): string {
  if (error !== undefined) return `unreadable (${error})`;
  const staleText = stale.length > 0 ? `, stale: ${stale.join(", ")}` : "";
  return `${count} in ${path}${staleText}`;
}
