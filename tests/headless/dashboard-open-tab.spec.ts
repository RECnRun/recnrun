import { askPeers } from "../browser/fixtures/master-restart.ts";
import { expect, test } from "../browser/fixtures/chrome.ts";
import { bindMasterSide, ensureOpen, masterLinked, modeProblems } from "./fixtures/e13-cells.ts";
import { v1Lab } from "./fixtures/e13-lab.ts";

/*
 * POC PLAN.md P7.7 on Google Chrome Stable: E13's setup (a master on a root of its own, one worker
 * root opened headless by the launcher's scripts with no CDP client on it), driven from the master's
 * dashboard instead of the page's messaging: the address field and the Open tab button of the
 * remote profile. The page is proven by the worker's own new tab, titled by the site, and by the
 * static server's log of the marker.
 */

const MARKER = "dashboardtab";

test("the master's dashboard opens a tab in a linked headless worker", async () => {
  test.setTimeout(480_000);
  const lab = await v1Lab(1);
  try {
    const [worker] = lab.workers;
    if (!worker) throw new Error("The lab made no worker.");
    const launched = await ensureOpen(lab, "headless");
    expect(launched.map((each) => each.code)).toEqual([0]);
    expect(await modeProblems(lab.probe, worker, "headless")).toEqual([]);
    expect(await masterLinked(lab, [worker.profileId])).toBeDefined();
    expect((await bindMasterSide(lab)).problems).toEqual([]);

    const { dashboard, site } = lab;
    await dashboard.reload();
    const form = dashboard.locator("form.open-tab");
    await expect(form).toHaveCount(1, { timeout: 120_000 });
    const id = `${MARKER}${Date.now().toString(36)}`;
    await form.locator('[data-field="open-tab-address"]').fill(site.startUrl(id));
    await form.getByRole("button", { name: "Open tab" }).click();
    await expect(form.locator('[data-field="open-tab-result"]')).toHaveText(/^Opened in /, {
      timeout: 60_000,
    });

    await expect
      .poll(() => site.seen.map((seen) => seen.path), { timeout: 90_000 })
      .toEqual(expect.arrayContaining([`/start/${id}`, `/marker/${id}`]));
    await expect
      .poll(
        async () => {
          const reply = await askPeers(dashboard, { type: "tabs", peer: worker.profileId });
          const tabs = reply.ok
            ? ((reply.result as { tabs?: { title?: string }[] }).tabs ?? [])
            : [];
          return tabs.map((tab) => tab.title);
        },
        { timeout: 90_000 },
      )
      .toContain(site.titleOf(id));
  } finally {
    await lab.dispose();
  }
});
