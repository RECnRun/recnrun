import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import type { JsonWebKey as NodeJwk } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { FsaWindow } from "./fsa-harness.ts";

/* Helpers of the owner-flow journey: the real lab launcher as a child, and what it leaves behind. */

const run = promisify(execFile);
const LAUNCHER = fileURLToPath(new URL("./launcher/launcher.sh", import.meta.url));

export interface Launcher {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

/** Starts `launcher.sh start <lab> --allow <origin> --pair <fp>` as the owner would, in the container. */
export function startLauncher(lab: string, origin: string, fp: string): Launcher {
  const child = spawn("sh", [LAUNCHER, "start", lab, "--allow", origin, "--pair", fp], {
    env: { ...process.env, RECNRUN_TEST_CONTAINER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", (data) => (text += String(data)));
  child.stderr.on("data", (data) => (text += String(data)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => text, exited };
}

/** The 64-hex fingerprint the launcher prints: SHA-256 of the page key's 91-byte SPKI. */
export async function masterFingerprint(page: Page): Promise<string> {
  const jwk = await page.evaluate(async () => {
    const { lab } = window as unknown as FsaWindow;
    await lab.pair();
    return lab.masterKey();
  });
  if (!jwk) throw new Error("The owner page holds no master key.");
  const spki = createPublicKey({ key: jwk as NodeJwk, format: "jwk" }).export({
    type: "spki",
    format: "der",
  });
  return createHash("sha256").update(spki).digest("hex");
}

/** Every process whose arguments name the lab's roots, with those arguments. */
export async function rootProcesses(lab: string): Promise<string[]> {
  const { stdout } = await run("ps", ["-ww", "-eo", "pid=,args="]);
  return stdout
    .split("\n")
    .filter((line) => line.includes(`${lab}/roots/`) && !line.includes(" ps -ww"));
}

export const launcherLog = (lab: string) =>
  readFile(join(lab, "state/launcher.log"), "utf8").catch(() => "");

/** The lab's files with their sizes, and the marker, for the journey's record. */
export async function labListing(lab: string): Promise<string> {
  const listed = await run("find", [
    lab,
    "-path",
    `${lab}/roots/w1/chrome`,
    "-prune",
    "-o",
    "-type",
    "f",
    "-printf",
    "%s %p\\n",
  ]);
  const marker = await readFile(join(lab, "workspace/recnrun-workspace.json"), "utf8").catch(
    String,
  );
  return `${listed.stdout}\nmarker: ${marker}`;
}

export const count = (text: string, needle: string) => text.split(needle).length - 1;

/** The banner line of the owner page. */
export const banner = (page: Page) => page.locator('section p[role="status"]');

// The banner offers its own "Choose folder" before the panel's, as the owner sees it first.
export async function clickButton(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).first().click();
}

/** Lays the frame's image out at a CSS size; the page's ResizeObserver sends it as the viewport. */
export const resizePanel = (page: Page, width: number, height: number) =>
  page.evaluate(
    ([w, h]) => {
      const image = document.getElementById("visual") as HTMLImageElement;
      Object.assign(image.style, { width: `${w}px`, height: `${h}px` });
    },
    [width, height] as const,
  );

/** The natural size of the JPEG the master shows now. */
export const naturalSize = (page: Page) =>
  page.evaluate(() => {
    type View = { natural: { width: number; height: number } | null };
    const lab = (window as unknown as { lab: { interactView: () => View } }).lab;
    return lab.interactView().natural;
  });

export async function waitDetail(page: Page, text: RegExp, timeout = 60_000): Promise<void> {
  await expect(page.locator("section p").nth(1)).toHaveText(text, { timeout });
}
