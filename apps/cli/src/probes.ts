import { spawn } from "node:child_process";
import { mkdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { parseBindingsFile } from "@recnrun/protocol";
import type { DoctorProbes } from "./doctor.ts";
import type { Connection } from "./connect.ts";

async function readBindings(path: string) {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const parsed = parseBindingsFile(JSON.parse(text));
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.file.bindings;
}

/** The real machine behind `doctor`: the service for Chrome and versions, the home folder for the rest. */
export function machineProbes(home: string, connection: Connection): DoctorProbes {
  const folder = join(home, ".recnrun");
  const bindingsPath = join(folder, "bindings.json");
  return {
    nodeVersion: process.versions.node,
    health: async () => {
      const health = await connection.client.call("health", {});
      return { serviceVersion: health.serviceVersion, chrome: health.chrome };
    },
    bindingsPath,
    readBindings: () => readBindings(bindingsPath),
    diskPath: folder,
    disk: async () => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const stats = await statfs(folder);
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    },
  };
}

/** Opens a URL with the platform's opener; resolves once it was launched. */
export function openUrl(url: string): Promise<void> {
  const [command, args] = openerFor(process.platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** The opener command of a platform: `open`, `start`, or `xdg-open`. */
export function openerFor(platform: string, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}
