import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createCdpAdapter } from "../../packages/adapter/src/index.ts";
import {
  classifyBinding,
  detectDuplicateBinding,
  resolveActorBindings,
  type BrowserAdapter,
} from "../../packages/engine/src/index.ts";
import { openBindingsStore, type BindingsStore } from "../../packages/persistence/src/index.ts";
import {
  validateFlow,
  type Flow,
  type ProfileBinding,
  type Step,
} from "../../packages/protocol/src/index.ts";
import { expect, launchChrome, test, type ChromeInstance } from "./fixtures/chrome.ts";
import { FIXTURE_ORIGIN, waitReady } from "./fixtures/fixture-app.ts";

const FORM = `${FIXTURE_ORIGIN}/routes/form`;

interface Bound {
  binding: ProfileBinding;
  adapter: BrowserAdapter;
  browser: Browser;
  page: Page;
}

/** Connects to a Chrome, stores its binding under a friendly name, and opens a Playwright page. */
async function bind(store: BindingsStore, name: string, chrome: ChromeInstance): Promise<Bound> {
  const adapter = createCdpAdapter();
  const handshake = await adapter.connect(chrome.wsEndpoint, {
    source: { userDataDir: chrome.userDataDir },
  });
  const now = new Date().toISOString();
  const binding: ProfileBinding = {
    name,
    wsEndpoint: handshake.endpoint,
    ...(await adapter.describeProfile()),
    createdAt: now,
    lastSeenAt: now,
  };
  expect(detectDuplicateBinding(await store.list(), binding)).toBeUndefined();
  await store.save(binding);
  const browser = await chromium.connectOverCDP(chrome.wsEndpoint);
  const [context = await browser.newContext()] = browser.contexts();
  return { binding, adapter, browser, page: await context.newPage() };
}

const twoActors: unknown = {
  schemaVersion: 1,
  id: "two-actors",
  name: "Each actor fills its own form",
  actors: { a: {}, b: {} },
  steps: [
    { id: "a-open", actor: "a", action: "navigate", url: FORM },
    { id: "b-open", actor: "b", action: "navigate", url: FORM },
    { id: "b-fill", actor: "b", action: "fill", target: { testId: "name" }, value: "Typed by b" },
    { id: "a-fill", actor: "a", action: "fill", target: { testId: "name" }, value: "Typed by a" },
  ],
};

// No replay executor exists before F1.6 and F2.5; this drives only what the mapping needs.
async function drive(page: Page, step: Step): Promise<void> {
  if (!("action" in step)) throw new Error(`Step ${step.id} is not an action.`);
  if (step.action === "navigate") {
    await page.goto(step.url);
    await waitReady(page, "form");
  } else if (step.action === "fill" && typeof step.target === "object" && "testId" in step.target) {
    await page.getByTestId(step.target.testId).fill(step.value);
  } else {
    throw new Error(`Step ${step.id} is outside this test.`);
  }
}

function flowOf(input: unknown): Flow {
  const validated = validateFlow(input);
  if (!validated.ok) throw new Error(JSON.stringify(validated.issues));
  return validated.flow;
}

const readStorage = (page: Page) =>
  page.evaluate(() => ({ stored: localStorage.getItem("binding"), cookie: document.cookie }));

test("two Chrome instances are two isolated bindings, and a restart is reported as stale", async ({
  chrome,
}) => {
  const home = await mkdtemp(join(tmpdir(), "recnrun-home-"));
  const second = await launchChrome();
  const bound: Bound[] = [];
  try {
    const store = openBindingsStore({ home });
    const ana = await bind(store, "Ana", chrome);
    const bob = await bind(store, "Bob", second);
    bound.push(ana, bob);
    console.log(`Bindings on ${chrome.version}: ${JSON.stringify(await store.list())}`);
    expect((await store.list()).map(({ name }) => name)).toEqual(["Ana", "Bob"]);
    expect(ana.binding).toMatchObject({
      userDataDir: chrome.userDataDir,
      chrome: expect.stringMatching(/^Chrome\//),
    });
    expect(ana.binding.browserContextIds).not.toEqual([]);

    // Storage written through binding A stays in A's profile.
    await drive(ana.page, { id: "open", action: "navigate", url: FORM });
    await ana.page.evaluate(() => {
      localStorage.setItem("binding", "Ana");
      document.cookie = "binding=Ana; path=/";
    });
    await drive(bob.page, { id: "open", action: "navigate", url: FORM });
    expect(await readStorage(ana.page)).toEqual({ stored: "Ana", cookie: "binding=Ana" });
    expect(await readStorage(bob.page)).toEqual({ stored: null, cookie: "" });
    expect(await bob.browser.contexts()[0]?.cookies(FIXTURE_ORIGIN)).toEqual([]);

    // Each step runs on the binding its actor resolves to.
    const flow = flowOf(twoActors);
    expect(resolveActorBindings(flow, { a: "Ana" })).toMatchObject({ ok: false, actor: "b" });
    const resolved = resolveActorBindings(flow, { a: "Ana", b: "Bob" });
    if (!resolved.ok) throw new Error(resolved.message);
    const byName = new Map(bound.map((entry) => [entry.binding.name, entry]));
    for (const step of flow.steps) {
      const target = byName.get(resolved.bindings[step.actor ?? ""] ?? "");
      if (!target) throw new Error(`Step ${step.id} has no binding.`);
      await drive(target.page, step);
    }
    await expect(ana.page.getByTestId("name")).toHaveValue("Typed by a");
    await expect(bob.page.getByTestId("name")).toHaveValue("Typed by b");

    // The same endpoint registered again under another name is a duplicate.
    expect(
      detectDuplicateBinding(await store.list(), { ...bob.binding, name: "Bob again" }),
    ).toEqual({
      existing: "Bob",
      field: "wsEndpoint",
    });

    // Kill and relaunch A on the same profile: reported stale, the stored binding stays as it was.
    process.kill(chrome.pid, "SIGKILL");
    const relaunched = await chrome.relaunch();
    const discovered = await ana.adapter.discover({ userDataDir: chrome.userDataDir });
    const probe = createCdpAdapter();
    const handshake = await probe.connect(relaunched.wsEndpoint, {
      source: { userDataDir: chrome.userDataDir },
    });
    const restartedProfile = await probe.describeProfile();
    await probe.disconnect();
    const classification = classifyBinding(ana.binding, discovered, handshake);
    console.log(
      `After the restart: ${JSON.stringify(classification)}; contexts ${JSON.stringify(restartedProfile.browserContextIds)}`,
    );
    expect(classification).toEqual({
      status: "stale-restarted",
      wsEndpoint: relaunched.wsEndpoint,
      changed: ["endpoint"],
    });
    expect((await store.list()).find(({ name }) => name === "Ana")).toEqual(ana.binding);
    // Context ids are per launch: they cannot recognize the profile after a restart.
    expect(restartedProfile.userDataDir).toBe(ana.binding.userDataDir);
    expect(restartedProfile.browserContextIds).not.toEqual(ana.binding.browserContextIds);
    const bobNow = await bob.adapter.discover({ userDataDir: second.userDataDir });
    expect(classifyBinding(bob.binding, bobNow)).toEqual({
      status: "fresh",
      wsEndpoint: second.wsEndpoint,
    });

    await second.close();
    const gone = await bob.adapter.discover({ userDataDir: second.userDataDir });
    expect(classifyBinding(bob.binding, gone)).toMatchObject({ status: "stale-missing" });
  } finally {
    for (const { adapter, browser } of bound) {
      await adapter.disconnect();
      await browser.close().catch(() => undefined);
    }
    await second.close();
    await rm(home, { recursive: true, force: true });
  }
});
