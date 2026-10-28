import type { BrowserContext, Page, Worker } from "@playwright/test";
import { createServer } from "node:http";
import { expect, test } from "./fixtures/extension.ts";

// A real loopback server: Chrome's Local Network Access check blocks a routed (public)
// page from framing a localhost address. No match pattern covers `forged.localhost`.
const FORGED_PORT = 5191;
const FORGED_ORIGIN = `http://forged.localhost:${FORGED_PORT}`;
let forgedBody = "";
const forgedServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(forgedBody);
});

const extensionOrigin = (worker: Worker) => `chrome-extension://${new URL(worker.url()).host}`;

/** No extension page is web-accessible, so Chrome answers a frame of one with its error page. */
async function expectBlocked(page: Page) {
  await expect.poll(() => page.frames().map((frame) => frame.url())).toHaveLength(2);
  const probe = page.frames()[1];
  await probe?.waitForLoadState();
  expect(probe?.url()).toBe("chrome-error://chromewebdata/");
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

test("another origin cannot frame the dashboard", async ({ context, serviceWorker }) => {
  const forged = await serveForged(context, "<p>Forged</p>");
  await appendFrame(forged, `${extensionOrigin(serviceWorker)}/dashboard.html`, "probe");
  await expectBlocked(forged);
});

test("not even the site's own script can frame the dashboard", async ({ page, serviceWorker }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RECnRun", level: 1 })).toBeVisible();
  await appendFrame(page, `${extensionOrigin(serviceWorker)}/dashboard.html`, "site-made");
  await expectBlocked(page);
  await expect(page.locator("iframe")).toHaveCount(1);
});
