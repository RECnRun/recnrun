import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { instrument } from "../../packages/adapter/src/index.ts";
import type { CapturedEvent, Cookie } from "../../packages/protocol/src/index.ts";
import { expect, test } from "./fixtures/capture.ts";

const KEY = "recnrun-fixture";
const HTTP_ONLY = "fixture-httponly";

type StorageEvent = Extract<CapturedEvent, { category: "storage" }>;

const isStorage = (event: CapturedEvent): event is StorageEvent => event.category === "storage";

/** A storage event's type with the fields a test compares. */
function summary(event: StorageEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const cookie = payload.cookie as Cookie | undefined;
  const fields = cookie
    ? [cookie.name, cookie.value ?? (cookie.redacted ? "redacted" : "")]
    : [payload.area, payload.operation, payload.key, payload.value ?? payload.newValue];
  return [event.type, payload.observation, ...fields.filter((field) => field !== undefined)].join(
    " ",
  );
}

async function press(page: Page, button: string, output: string, value: string) {
  await page.getByTestId(button).click();
  await expect(page.getByTestId(output)).toHaveText(value);
}

type Snapshot = Extract<StorageEvent, { type: "snapshot" }>;
type CookiesSnapshot = Extract<StorageEvent, { type: "cookies-snapshot" }>;

const snapshotOf = (events: StorageEvent[], area: string, reason: string) =>
  events.findLast(
    (event): event is Snapshot =>
      event.type === "snapshot" && event.payload.area === area && event.payload.reason === reason,
  );

test("Web Storage calls are observed operations and changes, and a navigation reads a snapshot", async ({
  app,
  captured,
}) => {
  const page = await app.open("storage");
  const targetId = await captured.targetOf(page);
  const events = () =>
    captured.events.filter(isStorage).filter((event) => event.targetId === targetId);
  await expect
    .poll(() => snapshotOf(events(), "local", "navigation")?.payload)
    .toMatchObject({
      observation: "snapshot",
      storageKey: "http://127.0.0.1:4600/",
      items: [],
    });
  await press(page, "local-set", "local-value", "fixture-local");
  await press(page, "session-set", "session-value", "fixture-session");
  await press(page, "local-clear", "local-value", "(none)");
  const operations = () =>
    events()
      .filter((event) => event.type === "operation")
      .map(summary);
  await expect
    .poll(operations)
    .toEqual([
      `operation observed-operation local setItem ${KEY} fixture-local`,
      `operation observed-operation session setItem ${KEY} fixture-session`,
      "operation observed-operation local clear",
    ]);
  const changes = () =>
    events()
      .filter((event) => event.type.startsWith("item"))
      .map(summary);
  await expect
    .poll(changes)
    .toEqual([
      `item-added observed-change local ${KEY} fixture-local`,
      `item-added observed-change session ${KEY} fixture-session`,
      "items-cleared observed-change local",
    ]);
  await page.reload();
  await expect
    .poll(() => snapshotOf(events(), "session", "navigation")?.payload.items)
    .toEqual([{ key: KEY, value: "fixture-session" }]);
});

test("cookie changes are read from the jar, and an HttpOnly cookie never keeps its value", async ({
  app,
  captured,
}, testInfo) => {
  const page = await app.open("storage");
  const targetId = await captured.targetOf(page);
  const cookies = () =>
    captured.events
      .filter(isStorage)
      .filter((event) => event.targetId === targetId && event.type.startsWith("cookie-"))
      .map(summary);
  await press(page, "cookie-set", "cookie-value", "fixture-cookie");
  await expect.poll(cookies).toEqual([`cookie-added observed-change ${KEY} fixture-cookie`]);
  await press(page, "httponly-set", "httponly-value", "set");
  await expect.poll(cookies).toHaveLength(2);
  await press(page, "cookie-clear", "cookie-value", "(none)");
  await expect.poll(cookies).toHaveLength(3);
  await press(page, "httponly-clear", "httponly-value", "cleared");
  await expect
    .poll(cookies)
    .toEqual([
      `cookie-added observed-change ${KEY} fixture-cookie`,
      `cookie-added observed-change ${HTTP_ONLY} redacted`,
      `cookie-removed observed-change ${KEY} fixture-cookie`,
      `cookie-removed observed-change ${HTTP_ONLY} redacted`,
    ]);
  await captured.finish();
  const journal = await readFile(testInfo.outputPath("events.jsonl"), "utf8");
  expect(journal).toContain(HTTP_ONLY);
  expect(journal).not.toContain("s3cr3t");
});

test("a page captured late reads a snapshot of what it already stored", async ({ app, chrome }) => {
  const page = await app.open("storage");
  await press(page, "local-set", "local-value", "fixture-local");
  await press(page, "httponly-set", "httponly-value", "set");
  const events: CapturedEvent[] = [];
  const handle = await instrument(chrome.wsEndpoint, {
    capture: {
      runId: "late-storage",
      cookiePollMs: 0,
      onEvent: (event) => void events.push(event),
    },
  });
  try {
    const snapshots = () =>
      events.filter(isStorage).filter((event) => event.payload.observation === "snapshot");
    await expect
      .poll(() => snapshotOf(snapshots(), "local", "attach")?.payload.items)
      .toEqual([{ key: KEY, value: "fixture-local" }]);
    const jar = () =>
      snapshots().find((event): event is CookiesSnapshot => event.type === "cookies-snapshot")
        ?.payload;
    await expect.poll(() => jar()?.reason).toBe("attach");
    const cookies = jar()?.cookies ?? [];
    expect(cookies.find((cookie) => cookie.name === HTTP_ONLY)).toEqual({
      name: HTTP_ONLY,
      domain: "127.0.0.1",
      path: "/",
      redacted: true,
      httpOnly: true,
      secure: false,
      session: true,
      sameSite: "Lax",
    });
    expect(JSON.stringify(events)).not.toContain("s3cr3t");
  } finally {
    handle.stop();
  }
});
