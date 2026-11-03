import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  FIXTURE_ORIGIN,
  homeWithChrome,
  removeHome,
  startServiceChild,
} from "./fixtures/local-service.ts";

const FLOW_ID = "fetch-json";

/** Opens the fixture's network route, fetches its JSON, and expects the 200 the API answers. */
const flowOf = (query: string) => ({
  schemaVersion: 1,
  id: FLOW_ID,
  name: "Fetch the fixture JSON",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [
    { id: "open", action: "navigate", url: `${FIXTURE_ORIGIN}/routes/network${query}` },
    { id: "fetch", action: "click", target: { testId: "fetch-json" } },
    { id: "result", assertion: "textContains", target: { testId: "result-json" }, expected: "200" },
  ],
});

/** Sends one command as the served UI does, with the token the service put in the page. */
async function command(ui: Page, name: string, params: unknown) {
  const answer = await ui.evaluate(
    async ({ name, params }) => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="recnrun-token"]');
      const response = await fetch("/api", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${meta?.content}` },
        body: JSON.stringify({ requestId: "e2e", command: name, params }),
      });
      return (await response.json()) as { ok: boolean; error?: { message: string } };
    },
    { name, params },
  );
  if (!answer.ok) throw new Error(`${name} failed: ${answer.error?.message}`);
}

/** Replays the flow from the Run screen and opens the finished run's diagnostics. */
async function runAndInspect(ui: Page, base: string, exitCode: number): Promise<string> {
  await ui.goto(`${base}#/flows/${FLOW_ID}/run`);
  await ui.getByRole("button", { name: "Start run" }).click();
  const summary = ui.getByRole("region", { name: "Run summary" });
  // The previous run's summary shows until the new one arrives; its exit code differs.
  await expect(summary).toContainText(`Exit code ${exitCode}`, { timeout: 60_000 });
  await ui.getByRole("button", { name: "Diagnostics" }).click();
  await expect(ui.getByRole("list", { name: "Timeline" })).toContainText("step.started");
  return decodeURIComponent(new URL(ui.url()).hash.replace("#/runs/", ""));
}

async function compareWith(ui: Page, baseline: string) {
  await ui.getByRole("combobox", { name: "Baseline run" }).fill(baseline);
  await ui.getByRole("button", { name: "Compare" }).click();
  return ui.getByRole("region", { name: "Comparison" });
}

/** A gap the network collector would write after losing two events of the fetch step. */
async function injectGap(home: string, runId: string) {
  const gap = {
    schemaVersion: 1,
    id: "cdp:network#1",
    runId,
    seq: 1,
    source: "cdp",
    producer: "cdp:network",
    component: "collector",
    timestamp: new Date().toISOString(),
    targetId: null,
    frameId: null,
    documentId: null,
    stepId: "fetch",
    category: "gap",
    type: "buffer-exhausted",
    payload: { reason: "buffer-exhausted", surface: "network", lost: 2 },
  };
  const journal = join(home, ".recnrun", "flows", FLOW_ID, "runs", runId, "events.jsonl");
  await appendFile(journal, `${JSON.stringify(gap)}\n`);
}

const shot = (ui: Page, info: TestInfo, name: string) =>
  ui.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });

test("compares a failing run with its baseline and never blames the application for a gap", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const { home, chrome } = await homeWithChrome();
  const service = await startServiceChild(home);
  try {
    await page.goto(service.url);
    await command(page, "flow.import", { flow: flowOf("") });
    const baseline = await runAndInspect(page, service.url, 0);
    await shot(page, info, "timeline");

    await command(page, "flow.save", { flow: flowOf("?fail=api-500") });
    await runAndInspect(page, service.url, 1);
    const api = page
      .getByRole("table", { name: "Requests" })
      .getByRole("row")
      .filter({ hasText: `${FIXTURE_ORIGIN}/api/json` });
    await expect(api).toHaveCount(1);
    await expect(api).toContainText("500");
    await expect(api).toContainText("fetch");
    await api.scrollIntoViewIfNeeded();
    await shot(page, info, "requests-500");
    const failing = await compareWith(page, baseline);
    await expect(failing).toContainText("Application failure");
    await expect(failing).toContainText("First divergence at step fetch");
    await expect(failing).toContainText("response status");
    await expect(failing).toContainText(`This run: 500 ${FIXTURE_ORIGIN}/api/json`);
    await expect(failing.getByRole("row", { name: /fetch/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await shot(page, info, "compare-500");

    await command(page, "flow.save", { flow: flowOf("") });
    const gapped = await runAndInspect(page, service.url, 0);
    await injectGap(home, gapped);
    await page.reload();
    await expect(page.getByRole("list", { name: "Timeline" })).toContainText(
      "collector gap: buffer-exhausted on network, 2 events lost",
    );
    const lost = await compareWith(page, baseline);
    await expect(lost).toContainText("Collector gap");
    await expect(lost).toContainText("Not an application failure");
    await expect(page.locator("main")).not.toContainText("Application failure");
    await shot(page, info, "compare-gap");
  } finally {
    await page.goto("about:blank");
    await service.stop();
    await chrome.close();
    await removeHome(home);
  }
});
