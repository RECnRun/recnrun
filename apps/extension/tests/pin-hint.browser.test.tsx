import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { PinHint } from "@/dashboard/PinHint";
import { fakeToolbarPin } from "./fake-extension";

function mount(pinned: boolean | Error) {
  const toolbar = fakeToolbarPin(pinned);
  const root = document.body.appendChild(document.createElement("div"));
  render(<PinHint pin={toolbar.pin} />, root);
  const hint = () => root.querySelector<HTMLElement>('section[aria-labelledby="pin-heading"]');
  return { ...toolbar, root, hint };
}

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("asks to pin RECnRun while its icon is not on the toolbar, and hides once pinned", async () => {
  const { hint, set, listeners, root } = mount(false);
  await expect.poll(() => hint()?.textContent).toContain("Pin RECnRun to the toolbar");
  expect(hint()?.textContent).toContain("Extensions menu");

  set(true);
  await expect.poll(hint).toBeNull();
  set(false);
  await expect.poll(hint).not.toBeNull();
  render(null, root);
  await expect.poll(() => listeners.size).toBe(0);
});

test("says nothing when RECnRun is pinned, or Chrome cannot tell", async () => {
  const pinned = mount(true);
  const unknown = mount(new Error("No action API."));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(pinned.hint()).toBeNull();
  expect(unknown.hint()).toBeNull();
  expect(unknown.root.textContent).toBe("");
});
