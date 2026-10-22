import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const html = read("../index.html").toString();
const links = [...html.matchAll(/<link rel="([^"]+)" href="([^"]+)"/g)].map(([, rel, href]) => ({
  rel,
  href,
}));

// Files in public keep their names; Vite adds a content hash only to files the page imports.
test("every icon the page links is a source file outside public", () => {
  const icons = links.filter(({ rel }) => rel?.includes("icon"));
  expect(icons.length).toBeGreaterThan(0);
  for (const { href } of icons) {
    expect(href).toMatch(/^\.\/icons\//);
    expect(existsSync(new URL(`../${href}`, import.meta.url))).toBe(true);
  }
});

// iOS browsers ignore SVG favicons.
test("the page links raster icons for browsers without SVG favicons", () => {
  expect(links).toContainEqual({ rel: "icon", href: "./icons/favicon.ico" });
  expect(links).toContainEqual({ rel: "apple-touch-icon", href: "./icons/apple-touch-icon.png" });
});

test("the touch icon is a 180 px PNG and the ICO holds 16, 32, and 48 px images", () => {
  const touch = read("../icons/apple-touch-icon.png");
  expect([touch.readUInt32BE(16), touch.readUInt32BE(20)]).toEqual([180, 180]);
  const ico = read("../icons/favicon.ico");
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16]);
  expect(sizes).toEqual([16, 32, 48]);
});
