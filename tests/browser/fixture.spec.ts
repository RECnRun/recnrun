import {
  compose,
  counters,
  expect,
  FIXTURE_ORIGIN,
  FORM_STATUS,
  networkResult,
  ROUTE_NAMES,
  SECOND_ORIGIN,
  state,
  submitForm,
  test,
  waitReady,
} from "./fixtures/fixture-app.ts";

test("opens every route, which passes its self-test and names itself", async ({ app }) => {
  const index = await app.open("index");
  for (const route of ROUTE_NAMES) {
    await expect(index.getByTestId(`route-${route}`)).toHaveAttribute("href", `/routes/${route}`);
  }
  for (const route of ROUTE_NAMES) {
    const page = await app.open(route);
    expect((await state(page))?.fail).toBe("");
    await page.close();
  }
});

test.describe("form", () => {
  test("renders a status text from every submitted control", async ({ app }) => {
    const page = await app.open("form");
    await submitForm(page);
    await expect(page.getByTestId("status")).toHaveText(FORM_STATUS);
    expect(await counters(page)).toMatchObject({ submits: 1 });
  });

  test("?fail=status breaks only the status text", async ({ app }) => {
    const page = await app.open("form", "?fail=status");
    expect((await state(page))?.fail).toBe("status");
    await submitForm(page);
    expect(await counters(page)).toMatchObject({ submits: 1 });
    await expect(page.getByTestId("status")).toHaveText(/^Submitted /);
    await expect(page.getByTestId("status")).not.toHaveText(FORM_STATUS);
  });
});

test("debounce runs its handler once after 300 ms of silence", async ({ app }) => {
  const page = await app.open("debounce");
  await page.getByLabel("Search").pressSequentially("hello", { delay: 50 });
  await expect(page.getByTestId("debounced")).toHaveText("Debounced: hello");
  expect(await counters(page)).toMatchObject({ inputs: 5, debounced: 1 });
});

test("spa changes views with pushState and no reload", async ({ app }) => {
  const page = await app.open("spa");
  const loadId = (await state(page))?.loadId;
  await expect(page.getByTestId("view")).toHaveText("View A");
  await page.getByRole("link", { name: "View B" }).click();
  await expect(page.getByTestId("view")).toHaveText("View B");
  expect(page.url()).toBe(`${FIXTURE_ORIGIN}/routes/spa?view=b`);
  await page.goBack();
  await expect(page.getByTestId("view")).toHaveText("View A");
  expect((await state(page))?.loadId).toBe(loadId);
  expect(await counters(page)).toMatchObject({ navigations: 1, popstates: 1 });
});

test("submit-redirect posts a form and lands on the result after a 303", async ({ app }) => {
  const page = await app.open("submit-redirect");
  await page.getByLabel("Name", { exact: true }).fill("Ada Lovelace");
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/submit"));
  await page.getByRole("button", { name: "Send" }).click();
  expect((await posted).status()).toBe(303);
  await waitReady(page, "submit-result");
  await expect(page.getByTestId("result")).toHaveText("Received Ada Lovelace");
});

test("iframe children report their origins from both ports", async ({ app }) => {
  const page = await app.open("iframe");
  await expect(page.getByTestId("origin-same")).toHaveText(FIXTURE_ORIGIN);
  await expect(page.getByTestId("origin-cross")).toHaveText(SECOND_ORIGIN);
  const child = page.frames().find((frame) => frame.url().startsWith(SECOND_ORIGIN));
  expect(child?.url()).toBe(`${SECOND_ORIGIN}/routes/iframe-child`);
  const session = await app.browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const outOfProcess = targetInfos.filter(({ type }) => type === "iframe").map(({ url }) => url);
  expect(outOfProcess, "the cross-site child is an OOPIF").toEqual([child?.url()]);
  expect(await counters(page)).toMatchObject({ messages: 2 });
});

test("popup child reports back to its opener", async ({ app }) => {
  const page = await app.open("popup");
  const opened = app.context.waitForEvent("page");
  await page.getByRole("button", { name: "Open popup" }).click();
  const popup = await opened;
  await waitReady(popup, "popup-child");
  await expect(page.getByTestId("popup-report")).toHaveText(`Popup ready at ${FIXTURE_ORIGIN}`);
  await expect(popup.getByTestId("report")).toHaveText("Reported to the opener");
  expect(await counters(page)).toMatchObject({ opens: 1, reports: 1 });
});

test("virtual list renders only the visible rows of 10 000", async ({ app }) => {
  const page = await app.open("virtual-list");
  const list = page.getByTestId("list");
  await expect(list).toHaveAttribute("data-total", "10000");
  const rows = page.locator('[data-testid^="row-"][data-key]');
  const rendered = await rows.count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(200);
  await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(page.getByTestId("row-9999")).toHaveAttribute("data-key", "row-key-9999");
  await page.getByRole("button", { name: "Select row 9999" }).click();
  await expect(page.getByTestId("selected")).toHaveText("Selected row 9999");
  expect(await rows.count()).toBeLessThan(200);
});

test("ime logs the composition event sequence", async ({ app }) => {
  const page = await app.open("ime");
  await page.getByLabel("Composition input").focus();
  await compose(page, "かな");
  await expect(page.getByTestId("ime-log")).toHaveText(
    "compositionstart, compositionupdate, compositionend",
  );
  await expect(page.getByLabel("Composition input")).toHaveValue("かな");
});

test("indexeddb keeps a committed record and drops an aborted one", async ({ app }) => {
  const page = await app.open("indexeddb");
  await expect(page.getByTestId("record-count")).toHaveText("Records: 0");
  await page.getByRole("button", { name: "Commit a record" }).click();
  await expect(page.getByTestId("last-outcome")).toHaveText("committed");
  await expect(page.getByTestId("record-count")).toHaveText("Records: 1");
  await page.getByRole("button", { name: "Abort a transaction" }).click();
  await expect(page.getByTestId("last-outcome")).toHaveText("aborted");
  await expect(page.getByTestId("record-count")).toHaveText("Records: 1");
  expect(await counters(page)).toMatchObject({ commits: 1, aborts: 1 });
});

test("service worker serves the second fetch from Cache Storage", async ({ app }) => {
  const page = await app.open("service-worker");
  await expect(page.getByTestId("sw-state")).toHaveText("controlled");
  await page.getByRole("button", { name: "Fetch twice" }).click();
  await expect(page.getByTestId("cache-result")).toHaveText("first: network, second: cache");
});

test.describe("network", () => {
  test("shows each result", async ({ app }) => {
    const page = await app.open("network");
    expect(await networkResult(page, "json")).toBe("200 alpha, beta, gamma");
    expect(await networkResult(page, "binary")).toMatch(/^200 image\/png \d+ bytes, PNG$/);
    expect(await networkResult(page, "error")).toBe("500 Server error on purpose");
    expect(await networkResult(page, "redirect")).toBe("200 redirected to /api/json");
    expect(await networkResult(page, "stream")).toMatch(/^10 chunks in \d+ ms$/);
    expect(await networkResult(page, "websocket")).toBe("echo: hello fixture");
  });

  test("?fail=api-500 makes the JSON button get a 500", async ({ app }) => {
    const page = await app.open("network", "?fail=api-500");
    const answered = page.waitForResponse((response) => response.url().includes("/api/json"));
    expect(await networkResult(page, "json")).toBe("500 Injected failure (fail=api-500)");
    expect((await answered).status()).toBe(500);
  });
});

test("console emits each level, an exception, and a rejection", async ({ app }) => {
  const page = await app.open("console");
  const levels: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => levels.push(message.type()));
  page.on("pageerror", (error) => errors.push(error.message));
  for (const name of ["console.log", "console.warn", "console.error", "Throw", "Reject"]) {
    await page.getByRole("button", { name }).click();
  }
  await expect.poll(() => errors.length).toBe(2);
  expect(levels).toEqual(["log", "warning", "error"]);
  expect(errors).toEqual(["Uncaught on purpose", "Rejected on purpose"]);
  expect(await counters(page)).toEqual({ log: 1, warn: 1, error: 1, throw: 1, reject: 1 });
});

test("?fail=throw raises a script error after the self-test", async ({ app }) => {
  const page = await app.context.newPage();
  const error = page.waitForEvent("pageerror");
  await page.goto(`${FIXTURE_ORIGIN}/routes/dialogs?fail=throw`);
  expect((await error).message).toBe("Injected failure (fail=throw)");
  await waitReady(page, "dialogs");
});

test("download serves an attachment", async ({ app }) => {
  const page = await app.open("download");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download the file" }).click();
  expect((await download).suggestedFilename()).toBe("recnrun-fixture.txt");
});

test("dialogs offers alert and confirm without opening them", async ({ app }) => {
  const page = await app.open("dialogs");
  await expect(page.getByRole("button", { name: "Show an alert" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Ask to confirm" })).toBeEnabled();
  await expect(page.getByTestId("dialog-outcome")).toHaveText("No dialog yet");
});

test("storage sets and clears local, session, and cookie values", async ({ app }) => {
  const page = await app.open("storage");
  const steps = [
    ["local-set", "local-value", "fixture-local"],
    ["local-remove", "local-value", "(none)"],
    ["session-set", "session-value", "fixture-session"],
    ["session-remove", "session-value", "(none)"],
    ["cookie-set", "cookie-value", "fixture-cookie"],
    ["cookie-clear", "cookie-value", "(none)"],
  ] as const;
  for (const [button, output, value] of steps) {
    await page.getByTestId(button).click();
    await expect(page.getByTestId(output)).toHaveText(value);
  }
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
