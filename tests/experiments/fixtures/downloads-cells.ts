import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, sep } from "node:path";
import type { DownloadPreferences, ProbeChrome, ProbeItem, Reply } from "./downloads.ts";
import { judged } from "./downloads-verdicts.ts";
import type { Sample, VerdictTarget } from "./downloads-verdicts.ts";
import { sized } from "../samples.ts";

/** A launched D0 on a fresh root; close() stops only that Chrome and removes the root. */
export interface Launched extends ProbeChrome {
  root: string;
  close(): Promise<void>;
}

/** What differs between the lab and the host twin; the cells are the same. */
export interface DownloadsEnvironment {
  target: VerdictTarget;
  launch(preferences: DownloadPreferences): Promise<Launched>;
  /**
   * Prepares where the default-location cell writes outside the root, before it downloads:
   * `relative` is the destination, and `clean` removes exactly what the cell wrote there.
   */
  defaultWorkspace(namespace: string): Promise<DefaultWorkspace>;
  /** The display's native windows, where xdotool can see them; otherwise `noDisplay` says why. */
  display?: {
    names(): Promise<Map<string, string>>;
    press(id: string, key: string): Promise<void>;
    screenshot(name: string): Promise<string>;
  };
  noDisplay: string;
}

/** The default-location cell's destination outside the root, and its cleanup. */
interface DefaultWorkspace {
  relative: string;
  clean(reported: string[]): Promise<Record<string, unknown>>;
}

const CUSTOM: DownloadPreferences = { location: "custom" };

export const freshNamespace = () => `e2-${randomUUID().slice(0, 8)}`;
export const relativeProbe = (namespace: string) => `RECnRun/poc/${namespace}/probe.json`;

/** A publication of folder-rendezvous.ts's presence shape, valid for 30 s. */
export function publication(now = Date.now()): string {
  const presence = { displayName: "E2", fingerprint: "AB:CD", createdAt: now };
  return JSON.stringify({ profileId: randomUUID(), ...presence, expiresAt: now + 30_000 });
}

/** A path as the verdict records it: the root and the home folder never appear in evidence. */
export function redact(path: string, root: string): string {
  return path.replace(root, "<root>").replace(homedir(), "~");
}

export async function withProbe<T>(
  environment: DownloadsEnvironment,
  preferences: DownloadPreferences,
  run: (launched: Launched) => Promise<T>,
): Promise<T> {
  const launched = await environment.launch(preferences);
  try {
    return await run(launched);
  } finally {
    await launched.close();
  }
}

/** The folder Chrome resolved, learned from the absolute path it reported, never guessed. */
export function learnedRoot(filename: string, relative: string): string | undefined {
  const native = relative.split("/").join(sep);
  return filename.endsWith(sep + native) ? filename.slice(0, -native.length - 1) : undefined;
}

const sameBytes = async (path: string, content: string) =>
  (await readFile(path).catch(() => undefined))?.equals(Buffer.from(content)) ?? false;

function itemProblems(reply: Reply<ProbeItem>): string[] {
  if (!reply.ok) return [`the probe failed: ${reply.error}`];
  const { state, filename } = reply.result;
  const problems = state === "complete" ? [] : [`state ${state} ${reply.result.error ?? ""}`];
  if (!isAbsolute(filename)) problems.push(`filename ${filename} is not absolute`);
  return problems;
}

/** One probe: completes, absolute, on disk, same bytes, and the same bytes again through file://. */
async function writeAndRead({ diagnostics, root }: Launched) {
  const namespace = freshNamespace();
  const content = publication();
  const reply = await diagnostics.probe(namespace, content);
  const problems = itemProblems(reply);
  if (!reply.ok) return { problems, observation: { error: reply.error }, root };
  const { filename, state } = reply.result;
  const onDisk = existsSync(filename);
  const nodeBytes = await sameBytes(filename, content);
  if (!onDisk || !nodeBytes) problems.push(`on disk ${onDisk}, same bytes ${nodeBytes}`);
  const read = await diagnostics.readBack(filename);
  const observation = { filename: redact(filename, root), state, onDisk, nodeBytes };
  return { problems, observation, read, content };
}

export const writeCompletes = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, CUSTOM, async (launched) => {
    const { problems, observation } = await writeAndRead(launched);
    return judged(problems, observation);
  });

export const fileUrlReads = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, CUSTOM, async (launched) => {
    const { problems, observation, read, content } = await writeAndRead(launched);
    const same = read?.ok === true && read.text === content;
    const url = read?.url ? redact(decodeURI(read.url), launched.root) : undefined;
    const pageProblems = same ? [] : [`file:// read ${read?.error ?? "returned other bytes"}`];
    return judged([...problems, ...pageProblems], { ...observation, url, pageRead: same });
  });

/** Writes `count` contents to one destination with `overwrite`; the names Chrome reported. */
async function overwrite(diagnostics: ProbeChrome["diagnostics"], count: number) {
  const namespace = freshNamespace();
  const names = new Set<string>();
  const failures = new Set<string>();
  let last = "";
  for (let index = 0; index < count; index++) {
    last = JSON.stringify({ write: index, at: Date.now() });
    const reply = await diagnostics.probe(namespace, last, { conflictAction: "overwrite" });
    if (reply.ok && reply.result.state === "complete") names.add(reply.result.filename);
    else failures.add(reply.ok ? reply.result.state : reply.error);
  }
  return { names, failures, last };
}

/** `sized(100, 5)` writes to one destination with `overwrite`: one name, the last content wins. */
export const overwriteMany = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, CUSTOM, async ({ diagnostics, root }) => {
    const writes = sized(100, 5);
    const started = Date.now();
    const { names, failures, last } = await overwrite(diagnostics, writes);
    const msPerWrite = Math.round((Date.now() - started) / writes);
    const [filename = ""] = names;
    const entries = filename ? await readdir(dirname(filename)) : [];
    const lastWins = filename !== "" && (await sameBytes(filename, last));
    const problems = [...failures].map((failure) => `a write failed: ${failure}`);
    if (names.size !== 1) problems.push(`${names.size} distinct names`);
    if (entries.some((entry) => /\(\d+\)/.test(entry)))
      problems.push(`uniquified: ${entries.join(", ")}`);
    if (!lastWins) problems.push("the last content did not win");
    const reported = [...names].map((name) => redact(name, root));
    return judged(problems, { writes, reported, entries, lastWins, msPerWrite });
  });
