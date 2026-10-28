import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";

const FORGED_ORIGIN = "http://forged.example";
const request = { channel: "recnrun", protocol: 1, kind: "request", type: "ping" };

interface Observed {
  replies: string[];
  opened?: Window | null;
}

const repliesOf = (page: Page) => page.evaluate(() => (window as unknown as Observed).replies);

test("answers its own page but ignores requests from another origin", async ({
  baseURL,
  context,
}) => {
  await context.addInitScript(() => {
    const observed = window as unknown as Observed;
    observed.replies = [];
    window.addEventListener("message", (event) => {
      const data = event.data as { kind?: string; id?: string };
      if (data.kind === "response" && data.id) observed.replies.push(data.id);
    });
  });
  await context.route(`${FORGED_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Forged</p>" }),
  );

  const forged = await context.newPage();
  await forged.goto(`${FORGED_ORIGIN}/`);
  const [site] = await Promise.all([
    context.waitForEvent("page"),
    forged.evaluate((url) => {
      (window as unknown as Observed).opened = window.open(url);
    }, `${baseURL}/`),
  ]);
  // The detected version proves the content script, and so the bridge host, is running.
  await expect(site.getByTestId("extension-version")).toHaveText("Extension 0.1.0");

  await forged.evaluate(
    (message) => (window as unknown as Observed).opened?.postMessage(message, "*"),
    { ...request, id: "forged" },
  );
  await site.evaluate((message) => window.postMessage(message, window.location.origin), {
    ...request,
    id: "own",
  });

  await expect.poll(() => repliesOf(site)).toContain("own");
  expect(await repliesOf(site)).not.toContain("forged");
});
