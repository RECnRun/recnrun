import { expect, test } from "vite-plus/test";
import { mount } from "@/app/mount";

test("renders the landing into the page's root element", () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  mount(root);
  expect(root.querySelector("h1")?.textContent).toBe("RECnRun");
});

test("leaves the page untouched when the root element is missing", () => {
  document.body.replaceChildren();
  expect(() => mount(null)).not.toThrow();
  expect(document.body.childElementCount).toBe(0);
});
