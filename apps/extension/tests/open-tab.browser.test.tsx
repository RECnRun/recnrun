import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { BOB_ID, fakePeerClient, statusOf } from "./fake-peer-client";
import { mount, remote } from "./peer-dashboard";
import { button, field, type } from "./queries";

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

const form = (root: HTMLElement) => root.querySelector<HTMLFormElement>("form.open-tab");
const result = (root: HTMLElement) =>
  root.querySelector('[data-field="open-tab-result"]')?.textContent;
const address = (root: HTMLElement) =>
  root.querySelector<HTMLInputElement>('[data-field="open-tab-address"]') ?? undefined;

test("an address typed for a verified linked profile is sent as the open-tab command", async () => {
  const peer = fakePeerClient(statusOf("connected"));
  const { root } = mount(peer);
  await expect.poll(() => form(root)).not.toBeNull();
  expect(remote(root)).toBeDefined();
  await type(address(root), "https://example.test/start");
  button(form(root) ?? root, "Open tab")?.click();
  await expect
    .poll(() => peer.asked("open-tab"))
    .toEqual([{ type: "open-tab", peer: BOB_ID, url: "https://example.test/start" }]);
  await expect.poll(() => result(root)).toBe("Opened in Bob.");
});

test("an address that is not http or https is refused before anything is sent", async () => {
  const peer = fakePeerClient(statusOf("connected"));
  const { root } = mount(peer);
  await expect.poll(() => form(root)).not.toBeNull();
  await type(address(root), "file:///etc/passwd");
  button(root, "Open tab")?.click();
  await expect.poll(() => result(root)).toBe("Type an http or https address.");
  expect(peer.asked("open-tab")).toHaveLength(0);
});

test("the reason the linked profile gave is shown", async () => {
  const peer = fakePeerClient(statusOf("connected"), {
    "open-tab": () => {
      throw new Error("Bob refused the address");
    },
  });
  const { root } = mount(peer);
  await expect.poll(() => form(root)).not.toBeNull();
  await type(address(root), "https://example.test/");
  button(root, "Open tab")?.click();
  await expect.poll(() => result(root)).toBe("Bob refused the address");
});

test("a profile whose link is not verified offers no address field", async () => {
  const { root } = mount(fakePeerClient(statusOf("connected", false)));
  await expect.poll(() => remote(root)).toBeDefined();
  expect(form(root)).toBeNull();
  expect(field(root, "open-tab")).toBeUndefined();
});
