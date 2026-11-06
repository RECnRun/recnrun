import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { UnavailableError } from "../../browser/fixtures/policy-install.ts";
import type { Diagnostics, ProbeItem, Reply } from "./downloads.ts";
import { freshNamespace, overwrite, publication, redact, withProbe } from "./downloads-cells.ts";
import type { DownloadsEnvironment } from "./downloads-cells.ts";
import { historyProblems, uiProblems } from "./downloads-traces.ts";
import type { HistoryAnswer, ProbeAnswer } from "./downloads-traces.ts";
import { judged } from "./downloads-verdicts.ts";
import type { Sample } from "./downloads-verdicts.ts";
import { sized } from "../samples.ts";

const CUSTOM = { location: "custom" } as const;
// The bubble's auto-open and the history write both follow the item's completion.
const SETTLE_MS = 1_500;

const answer = (reply: Reply<ProbeItem>): ProbeAnswer =>
  reply.ok ? { ok: true, filename: reply.result.filename } : reply;

const history = (reply: Awaited<ReturnType<Diagnostics["search"]>>): HistoryAnswer =>
  reply.ok ? { ok: true, filenames: reply.result.items.map((item) => item.filename) } : reply;

/** Chrome's download history: one entry after one write; the count after the overwrites, recorded. */
export const historyTraces = (environment: DownloadsEnvironment): Promise<Sample> =>
  withProbe(environment, CUSTOM, async ({ diagnostics, root }) => {
    const reply = await diagnostics.probe(freshNamespace(), publication());
    const afterOne = history(await diagnostics.search());
    const writes = sized(100, 5);
    await overwrite(diagnostics, writes);
    const afterOverwrites = history(await diagnostics.search());
    const count = (seen: HistoryAnswer) => (seen.ok ? seen.filenames.length : seen.error);
    const observation = {
      afterOne: count(afterOne),
      entries: afterOne.ok ? afterOne.filenames.map((name) => redact(name, root)) : [],
      overwrites: writes,
      afterOverwrites: count(afterOverwrites),
    };
    return judged(historyProblems(answer(reply), afterOne), observation);
  });

/** What a person sees, where xdotool can list the windows: Chrome's window, new ones, a screenshot. */
export const uiTraces = (environment: DownloadsEnvironment): Promise<Sample> => {
  const { display } = environment;
  if (!display) throw new UnavailableError(environment.noDisplay);
  return withProbe(environment, CUSTOM, async ({ diagnostics }) => {
    const before = await display.names();
    const reply = await diagnostics.probe(freshNamespace(), publication());
    await delay(SETTLE_MS);
    const after = await display.names();
    const screenshot = await display.screenshot("E2-traces.png");
    const screenshotBytes = (await stat(screenshot).catch(() => undefined))?.size ?? 0;
    const seen = { before: [...before.values()], after: [...after.values()], screenshotBytes };
    const newWindows = [...after].filter(([id]) => !before.has(id)).map(([, name]) => name);
    const observation = {
      windows: [...new Set(seen.after.filter(Boolean))],
      newWindows,
      notifications: "D0 declares no notifications permission; Chrome's own download UI only",
      screenshot,
    };
    return judged(uiProblems(answer(reply), seen), observation);
  });
};
