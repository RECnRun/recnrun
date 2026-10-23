import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/extension.ts";

// Browsers load a font face only when text uses it, so "loaded" proves the text renders in it.
async function brandFont(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter(
      (face) => face.family.replaceAll('"', "") === "Mona Sans",
    );
    return {
      status: faces.map((face) => face.status),
      ligatures: getComputedStyle(document.body).fontVariantLigatures,
    };
  });
}

// GitHub's brand rules turn ligatures off in headlines and body copy.
const expected = { status: ["loaded"], ligatures: "none" };

// The CSP allows only same-origin fonts, so the site must serve Mona Sans itself.
test("the website renders text in Mona Sans under its CSP", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => brandFont(page)).toEqual(expected);
});

test("the popup renders text in Mona Sans", async ({ page, serviceWorker }) => {
  await page.goto(`chrome-extension://${new URL(serviceWorker.url()).host}/popup.html`);
  await expect.poll(() => brandFont(page)).toEqual(expected);
});
