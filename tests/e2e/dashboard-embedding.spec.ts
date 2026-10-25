import type { BrowserContext, Page, Worker } from "@playwright/test";
import { createServer } from "node:http";
import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "./fixtures/extension.ts";

// A real loopback server: Chrome's Local Network Access check blocks a routed (public)
// page from framing the localhost preview, which recnrun.com in production would not hit.
// No match pattern covers `forged.localhost`, so it is a foreign origin to the extension.
const FORGED_PORT = 5191;
const FORGED_ORIGIN = `http://forged.localhost:${FORGED_PORT}`;
let forgedBody = "";
const forgedServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(forgedBody);
});

const extensionOrigin = (worker: Worker) => `chrome-extension://${new URL(worker.url()).host}`;

function recordConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (message) => lines.push(message.text()));
  return lines;
}

async function serveForged(context: BrowserContext, body: string): Promise<Page> {
  forgedBody = body;
  const forged = await context.newPage();
  await forged.goto(`${FORGED_ORIGIN}/`);
  return forged;
}

function appendFrame(page: Page, src: string, title: string) {
  return page.evaluate(
    ({ src, title }) => {
      const iframe = document.createElement("iframe");
      iframe.title = title;
      iframe.src = src;
      document.body.append(iframe);
    },
    { src, title },
  );
}

test.beforeAll(() => new Promise<void>((resolve) => forgedServer.listen(FORGED_PORT, resolve)));
test.afterAll(() => new Promise<void>((resolve) => forgedServer.close(() => resolve())));

test.beforeEach(async ({ seedSnapshot }) => {
  await seedSnapshot(sampleSnapshot());
});

for (const [name, path] of [
  ["the dashboard", "dashboard.html"],
  ["the session page", "session.html"],
] as const) {
  test(`another origin cannot frame ${name}`, async ({ context, serviceWorker }) => {
    const forged = await serveForged(context, "<p>Forged</p>");
    await appendFrame(forged, `${extensionOrigin(serviceWorker)}/${path}`, "probe");

    await expect.poll(() => forged.frames().map((frame) => frame.url())).toHaveLength(2);
    const probe = forged.frames()[1];
    await probe?.waitForLoadState();
    expect(probe?.url()).toBe("chrome-error://chromewebdata/");
  });
}

test("the site's own script can frame the dashboard under the production CSP", async ({
  page,
  serviceWorker,
}) => {
  const lines = recordConsole(page);
  await page.goto("/");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /default-src 'self'/,
  );
  await appendFrame(page, `${extensionOrigin(serviceWorker)}/dashboard.html`, "site-made");

  const dashboard = page.locator('iframe[title="site-made"]').contentFrame();
  await expect(dashboard.getByRole("article")).toHaveCount(2);
  expect(lines.filter((line) => /Content Security Policy/i.test(line))).toEqual([]);
});

test("does not mount the dashboard when the site itself is framed by another origin", async ({
  baseURL,
  context,
}) => {
  const forged = await serveForged(context, `<iframe title="site" src="${baseURL}/"></iframe>`);
  const site = forged.locator('iframe[title="site"]').contentFrame();
  await expect(site.getByRole("heading", { name: "RECnRun", level: 1 })).toBeVisible();
  await expect(site.locator('iframe[title="RECnRun dashboard"]')).toHaveCount(0);
});

test("refuses to render when an ancestor frame is not an allowed origin", async ({
  baseURL,
  context,
  serviceWorker,
}) => {
  const forged = await serveForged(context, `<iframe title="site" src="${baseURL}/"></iframe>`);
  const site = forged.locator('iframe[title="site"]').contentFrame();
  await expect(site.getByRole("heading", { name: "RECnRun", level: 1 })).toBeVisible();
  const siteFrame = forged.frames().find((frame) => frame.url().startsWith(`${baseURL}`));
  // Simulates script on the site (for example an XSS) framing the dashboard while clickjacked.
  await siteFrame?.evaluate(
    (src) => {
      const iframe = document.createElement("iframe");
      iframe.title = "nested";
      iframe.src = src;
      document.body.append(iframe);
    },
    `${extensionOrigin(serviceWorker)}/dashboard.html`,
  );

  const dashboard = forged
    .locator('iframe[title="site"]')
    .contentFrame()
    .locator('iframe[title="nested"]')
    .contentFrame();
  await expect(dashboard.getByRole("alert")).toHaveText(
    `RECnRun does not run inside ${FORGED_ORIGIN}.`,
  );
  await expect(dashboard.getByRole("link")).toHaveCount(0);
});
