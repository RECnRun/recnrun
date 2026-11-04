import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { UnavailableError } from "../../browser/fixtures/policy-install.ts";
import { stallingSource } from "./downloads.ts";
import type { Diagnostics, ProbeItem } from "./downloads.ts";
import {
  freshNamespace,
  publication,
  redact,
  relativeProbe,
  withProbe,
} from "./downloads-cells.ts";
import type { DownloadsEnvironment } from "./downloads-cells.ts";
import { judged } from "./downloads-verdicts.ts";
import type { Sample } from "./downloads-verdicts.ts";

const POLL_MS = 100;
const WAIT_MS = 15_000;

async function poll<T>(read: () => Promise<T | undefined>, ms = WAIT_MS): Promise<T | undefined> {
  for (let left = ms / POLL_MS; left > 0; left--) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(POLL_MS);
  }
  return undefined;
}

const partials = async (folder: string) =>
  (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".crdownload"));

async function stopped(diagnostics: Diagnostics, id: number): Promise<ProbeItem | undefined> {
  return poll(async () => {
    const reply = await diagnostics.search(id);
    const [item] = reply.ok ? reply.result.items : [];
    return item && item.state !== "in_progress" ? item : undefined;
  });
}

interface Target {
  root: string;
  directory: string;
  namespace: string;
  filename: string;
  previous: unknown;
}

/** Starts an overwrite from a stalling loopback source, stops it with `stop`, and reads around it. */
async function interruptOnce(
  diagnostics: Diagnostics,
  target: Target,
  stop: (id: number) => Promise<unknown>,
  source: string,
) {
  const { namespace, filename, previous } = target;
  const started = await diagnostics.probe(namespace, "", { url: source, settle: false });
  if (!started.ok) return { error: started.error };
  const { id } = started.result;
  const folder = dirname(filename);
  const during = await poll(async () =>
    (await partials(folder)).length > 0 ? partials(folder) : undefined,
  );
  const readDuring = await diagnostics.readPublication(filename, previous);
  await stop(id);
  const item = await stopped(diagnostics, id);
  const entries = await readdir(folder);
  const readAfter = await diagnostics.readPublication(filename, previous);
  // Chrome resumes some interrupted downloads by itself; one still running is cancelled here.
  const cleanup = item ? undefined : await diagnostics.cancel(id);
  const final = item ?? (cleanup?.ok ? cleanup.result : undefined);
  const settled = final && {
    state: final.state,
    error: final.error,
    filename: redact(final.filename, target.root),
  };
  const downloads = await readdir(target.directory);
  const stoppedWithin15s = Boolean(item);
  return {
    during: during ?? [],
    readDuring,
    stoppedWithin15s,
    settled,
    entries,
    downloads,
    readAfter,
  };
}

/** A cancelled and a network-interrupted overwrite: the reader keeps the last valid publication. */
export const interruptedTolerated = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, { location: "custom" }, async ({ diagnostics, root, directory = "" }) => {
    const namespace = freshNamespace();
    const content = publication();
    const first = await diagnostics.probe(namespace, content);
    if (!first.ok) return judged([`the first probe failed: ${first.error}`], {});
    const previous = JSON.parse(content) as { createdAt: number; profileId: string };
    const target = { root, directory, namespace, filename: first.result.filename, previous };
    const source = await stallingSource();
    try {
      const cancelled = await interruptOnce(
        diagnostics,
        target,
        (id) => diagnostics.cancel(id),
        source.url,
      );
      const dropped = await interruptOnce(
        diagnostics,
        target,
        async () => source.abort(),
        source.url,
      );
      const reads = [cancelled, dropped].flatMap((run) =>
        "readDuring" in run ? [run.readDuring, run.readAfter] : [],
      );
      const kept = reads.filter((read) => read?.publication?.profileId === previous.profileId);
      const problems =
        reads.length === 4 && kept.length === 4 ? [] : ["the reader lost the previous publication"];
      const requests = [...source.requests];
      return judged(problems, { relative: relativeProbe(namespace), cancelled, dropped, requests });
    } finally {
      await source.close();
    }
  });

const SAVE_DIALOG = /save/i;

/** Escape in the dialog until the probe answers, at most three times; each press is a gesture. */
async function dismiss(
  display: NonNullable<DownloadsEnvironment["display"]>,
  [id, title]: [string, string],
  reply: Promise<unknown>,
) {
  const state = { answered: false };
  void reply.finally(() => (state.answered = true));
  const steps: string[] = [];
  while (!state.answered && steps.length < 3) {
    await display.press(id, "Escape");
    steps.push(`xdotool: Escape in the "${title}" dialog`);
    await poll(async () => (state.answered ? true : undefined), 5_000);
  }
  return steps;
}

/** "Ask where to save" turns the write into a native dialog: seen, dismissed by keyboard, nothing written. */
export const saveAsPrompts = (environment: DownloadsEnvironment): Promise<Sample> => {
  const { display } = environment;
  if (!display) throw new UnavailableError(environment.noDisplay);
  return withProbe(
    environment,
    { location: "custom", prompt: true },
    async ({ diagnostics, directory = "" }) => {
      const namespace = freshNamespace();
      const before = await display.names();
      const reply = diagnostics.probe(namespace, publication());
      const found = async () => {
        const fresh = [...(await display.names())].filter(([id]) => !before.has(id));
        const dialog = fresh.find(([, name]) => SAVE_DIALOG.test(name));
        return dialog ? { dialog, fresh: fresh.map(([, name]) => name) } : undefined;
      };
      const shown = await poll(found);
      const screenshot = shown ? await display.screenshot("E2-save-as.png") : undefined;
      const steps = shown ? await dismiss(display, shown.dialog, reply) : [];
      const answered = await reply;
      const written = existsSync(join(directory, relativeProbe(namespace)));
      const problems = [];
      if (!shown) problems.push("no Save dialog showed");
      if (written) problems.push("the probe was written without an answer");
      const observation = { title: shown?.dialog[1], newWindows: shown?.fresh, answered };
      return judged(problems, { ...observation, written, screenshot }, steps);
    },
  );
};

/** What a person sees: new windows (bubble, shelf), Chrome's history count, notifications. */
export const visibleTraces = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, { location: "custom" }, async ({ diagnostics }) => {
    const { display } = environment;
    const before = await display?.names();
    const reply = await diagnostics.probe(freshNamespace(), publication());
    await delay(1_500);
    const after = await display?.names();
    const shown =
      after && before
        ? [...after].filter(([id]) => !before.has(id)).map(([, name]) => name)
        : undefined;
    const screenshot = await display?.screenshot("E2-traces.png");
    const history = await diagnostics.search();
    const observation = {
      newWindows: shown ?? `not observable: ${environment.noDisplay}`,
      history: history.ok ? history.result.count : history.error,
      notifications: "D0 declares no notifications permission; Chrome's own download UI only",
      screenshot,
    };
    return judged(reply.ok ? [] : [`the probe failed: ${reply.error}`], observation);
  });
