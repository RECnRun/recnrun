import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  freshNamespace,
  learnedRoot,
  publication,
  redact,
  relativeProbe,
  withProbe,
} from "./downloads-cells.ts";
import type { DownloadsEnvironment, Launched } from "./downloads-cells.ts";
import { judged } from "./downloads-verdicts.ts";
import type { Sample } from "./downloads-verdicts.ts";

/** Names and contents CHROMIUM.md group 4 says Chrome may rewrite (`%` becomes `_`). */
const ROUND_TRIPS = [
  { name: "empty content", file: "probe.json", content: "" },
  { name: "spaces", file: "probe with spaces.json", content: "  two  spaces  " },
  { name: "unicode", file: "próbé 日本.json", content: '{"text":"ção 日本 🎉"}' },
  { name: "percent", file: "probe%20x%.json", content: "100% %20" },
  { name: "hash", file: "probe#1.json", content: "#1 #2" },
  { name: "question mark", file: "probe?x=1.json", content: "?x=1&y" },
];

async function roundTrip(
  { diagnostics, root }: Launched,
  namespace: string,
  item: (typeof ROUND_TRIPS)[number],
) {
  const reply = await diagnostics.probe(namespace, item.content, {
    filename: `RECnRun/poc/${namespace}/${item.file}`,
  });
  if (!reply.ok) return { name: item.name, requested: item.file, refused: reply.error };
  const { filename, state } = reply.result;
  const bytes = await readFile(filename).catch(() => undefined);
  const node = bytes?.equals(Buffer.from(item.content)) ?? false;
  const read = await diagnostics.readBack(filename);
  const page = read.ok && read.text === item.content;
  const reported = basename(filename);
  return {
    name: item.name,
    requested: item.file,
    reported,
    state,
    node,
    page,
    url: read.url && redact(read.url, root),
  };
}

/** Each case reads back from the path Chrome reports, whatever name it chose. */
export const contentRoundTrips = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, { location: "custom" }, async (launched) => {
    const namespace = freshNamespace();
    const cases = [];
    for (const item of ROUND_TRIPS) cases.push(await roundTrip(launched, namespace, item));
    const problems = cases.flatMap((each) => {
      if ("refused" in each) return [`${each.name} refused: ${each.refused}`];
      return each.node && each.page ? [] : [`${each.name}: node ${each.node}, page ${each.page}`];
    });
    return judged(problems, { cases });
  });

/** The custom folder written into the root's preferences, learned back from `filename`. */
export const customLocation = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, { location: "custom" }, async ({ diagnostics, root, directory = "" }) => {
    const namespace = freshNamespace();
    const reply = await diagnostics.probe(namespace, publication());
    if (!reply.ok) return judged([`the probe failed: ${reply.error}`], {});
    const learned = learnedRoot(reply.result.filename, relativeProbe(namespace));
    const expected = realpathSync(directory);
    const problems = learned === expected ? [] : [`learned ${learned}, set ${expected}`];
    const observation = { learned: learned && redact(learned, root), set: redact(expected, root) };
    return judged(problems, { ...observation, state: reply.result.state });
  });

/** Chrome's own default folder: recorded, then exactly the files written there are removed. */
export const defaultLocation = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, { location: "default" }, async ({ diagnostics, root }) => {
    const namespace = freshNamespace();
    const relative = environment.defaultDestination(namespace);
    const content = publication();
    const reply = await diagnostics.probe(namespace, content, { filename: relative });
    if (!reply.ok) return judged([`the probe failed: ${reply.error}`], { relative });
    const { filename, state } = reply.result;
    const same = (await readFile(filename).catch(() => undefined))?.equals(Buffer.from(content));
    const learned = learnedRoot(filename, relative);
    const cleaned = await environment.cleanDefault([filename]);
    const problems = [];
    if (state !== "complete" || !same) problems.push(`state ${state}, same bytes ${same}`);
    if (!learned || !isAbsolute(learned)) problems.push(`no folder learned from ${filename}`);
    if (learned?.startsWith(root + sep)) problems.push("the default resolved inside the root");
    const observation = { learned: learned && redact(learned, root), relative, cleaned };
    return judged(problems, { ...observation, state });
  });

/** Absolute and `..` destinations are refused before anything is written. */
export const absoluteRefused = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, { location: "custom" }, async ({ diagnostics, root, directory = "" }) => {
    const namespace = freshNamespace();
    const escapes = [
      { path: join(root, "escape-absolute.json"), lands: join(root, "escape-absolute.json") },
      {
        path: `RECnRun/poc/${namespace}/../escape.json`,
        lands: join(directory, "RECnRun/poc/escape.json"),
      },
      { path: "../escape.json", lands: join(root, "escape.json") },
    ];
    const cases = [];
    for (const { path, lands } of escapes) {
      const reply = await diagnostics.probe(namespace, "{}", { filename: path });
      const error = reply.ok ? undefined : reply.error;
      cases.push({ requested: redact(path, root), error, written: existsSync(lands) });
    }
    const problems = cases.flatMap((each) =>
      each.error && !each.written ? [] : [`${each.requested} was accepted`],
    );
    return judged(problems, { cases });
  });
