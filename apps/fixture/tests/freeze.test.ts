import { expect, test } from "vite-plus/test";
import { hashAssets, readFreeze } from "@scripts/assets.ts";

test("every served file and server module matches freeze.json", async () => {
  const current = await hashAssets();

  // A difference means the application under test changed: freeze again only with the owner's agreement.
  expect(current).toEqual(await readFreeze());
});

test("the frozen set covers the server and both public roots", async () => {
  const paths = Object.keys(await hashAssets());

  expect(paths).toEqual(expect.arrayContaining(["src/server.ts", "public/app/sw-main.js"]));
  expect(paths.some((path) => path.startsWith("public/idp/"))).toBe(true);
});
