import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cloneControlScene } from "./fixtures/clone-control-rig.ts";
import type { CloneControlScene } from "./fixtures/clone-control-rig.ts";

/*
 * POC PLAN.md P7.6 on Google Chrome Stable: the master's dashboard section "Clones" writes request.json
 * through chrome.downloads, and the real launcher pass (recnrun-launcher.sh start --once) answers with
 * status.json and clones.json. Chrome on the clone is the lab's stub, which shows its mode in its
 * arguments as the real one does. The test writes neither clones.json nor status.json.
 */

const PAGE_MS = 20_000;

let scene: CloneControlScene | undefined;

test.afterEach(async () => {
  await scene?.dispose();
  scene = undefined;
});

const row = (current: CloneControlScene) =>
  current.dashboard.locator('[data-field="clone"]').first();
const stateOf = (current: CloneControlScene) => row(current).locator('[data-field="state"]');
const press = (current: CloneControlScene, name: string) =>
  current.dashboard.getByRole("button", { name, exact: true }).click({ timeout: PAGE_MS });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The id of a request folder the page wrote: a new UUID folder whose request.json is complete and matches. */
async function requested(current: CloneControlScene, known: string[], action: string) {
  const instanceId = (JSON.parse(current.rig.clonesJson()) as { clones: { instanceId: string }[] })
    .clones[0]?.instanceId;
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const all = await readdir(current.control).catch(() => [] as string[]);
        for (const each of all.filter((name) => UUID.test(name) && !known.includes(name))) {
          const text = await readFile(join(current.control, each, "request.json"), "utf8").catch(
            () => "",
          );
          const body = (() => {
            try {
              return JSON.parse(text) as Record<string, unknown>;
            } catch {
              return {};
            }
          })();
          if (body.requestId === each && body.kind === "clone-control") {
            if (body.action === action && body.instanceId === instanceId) id = each;
          }
        }
        return id;
      },
      { timeout: PAGE_MS },
    )
    .toBeTruthy();
  return id as string;
}

const ACTIONS: Record<string, string> = {
  "Open headless": "open-headless",
  "Reopen visible": "reopen-visible",
  Close: "close",
};

async function ask(current: CloneControlScene, button: string, known: string[]) {
  await press(current, button);
  const id = await requested(current, known, ACTIONS[button] as string);
  expect(current.rig.pass().code).toBe(0);
  return id;
}

test("the dashboard opens, reopens, and closes a clone through the real launcher", async () => {
  test.setTimeout(180_000);
  const current = (scene = await cloneControlScene());
  const { rig } = current;
  // The owner has closed the clone before any pass opens it.
  expect(rig.hold().code).toBe(0);
  expect(rig.pass().code).toBe(0);
  expect(rig.clonesJson()).toMatch(/"state":"closed"/);
  await expect(stateOf(current)).toHaveText("closed", { timeout: PAGE_MS });
  expect(rig.field("status")).toBe("stopped");

  const known: string[] = [];
  known.push(await ask(current, "Open headless", known));
  await expect(stateOf(current)).toHaveText("open (headless)", { timeout: PAGE_MS });
  expect(rig.field("status")).toBe("open");
  expect(rig.field("mode")).toBe("headless");

  known.push(await ask(current, "Reopen visible", known));
  await expect(stateOf(current)).toHaveText("open (headed)", { timeout: PAGE_MS });
  expect(rig.field("mode")).toBe("headed");
  expect(rig.signals().length).toBeGreaterThan(0);

  known.push(await ask(current, "Close", known));
  await expect(stateOf(current)).toHaveText("closed", { timeout: PAGE_MS });
  expect(rig.field("status")).toBe("stopped");
  const launches = rig.launches();
  for (let later = 0; later < 3; later += 1) expect(rig.pass().code).toBe(0);
  expect(rig.field("status")).toBe("stopped");
  expect(rig.launches()).toBe(launches);
  await expect(stateOf(current)).toHaveText("closed", { timeout: PAGE_MS });
});
