import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import {
  BOB_ID,
  CAROL_ID,
  closedFor,
  fakePeerClient,
  pausedBob,
  statusOf,
  withCarol,
  withPeerSession,
} from "./fake-peer-client";
import { buttons, item } from "./dashboard-page";
import { NOTES, headings, lineOf, mount, note, notes, remote } from "./peer-dashboard";
import { button } from "./queries";

const titles = (scope: HTMLElement | undefined) =>
  [...(scope?.querySelectorAll("li.tab") ?? [])].map((each) => each.getAttribute("aria-label"));

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("lists each peer's tabs under its name", async () => {
  const peer = fakePeerClient(withCarol(statusOf("connected")));
  const { root } = mount(peer);
  await expect
    .poll(() => headings(root))
    .toEqual(["Chrome — Alice (Local)", "Chrome — Bob (Connected)", "Chrome — Carol (Connected)"]);
  await expect.poll(() => titles(remote(root, "Carol"))).toEqual(["Notes"]);
  expect(titles(remote(root, "Bob"))).toEqual(["Mail"]);
  button(remote(root, "Carol") ?? root, "Show tab")?.click();
  await expect
    .poll(() => peer.asked("activate"))
    .toEqual([{ type: "activate", peer: CAROL_ID, tabId: NOTES.id }]);
  // Each peer has its own line in the pairing section.
  expect(lineOf(root, "Bob")?.textContent).toContain("Forget Bob");
  expect(lineOf(root, "Carol")?.textContent).toContain("Forget Carol");
});

test("Disconnect on one peer leaves the other's list live", async () => {
  const peer = fakePeerClient(withCarol(statusOf("connected")));
  const { root } = mount(peer);
  await expect.poll(() => lineOf(root, "Bob")).toBeDefined();
  button(lineOf(root, "Bob") ?? root, "Disconnect")?.click();
  await expect.poll(() => peer.asked("disconnect")).toEqual([{ type: "disconnect", peer: BOB_ID }]);

  peer.change(withCarol(pausedBob(closedFor("disconnected", "closed-here"))));
  await expect
    .poll(() => note(remote(root, "Bob")))
    .toBe("Not connected. These tabs are as last seen.");
  expect(buttons(item(remote(root, "Bob") ?? root, "Mail"))).toEqual([]);
  expect(buttons(item(remote(root, "Carol") ?? root, "Notes"))).toEqual(["Record", "Show tab"]);
  expect(button(lineOf(root, "Bob") ?? root, "Disconnect")).toBeUndefined();
  expect(button(lineOf(root, "Carol") ?? root, "Disconnect")).toBeDefined();
  button(lineOf(root, "Bob") ?? root, "Reconnect")?.click();
  await expect.poll(() => peer.asked("reconnect")).toEqual([{ type: "reconnect", peer: BOB_ID }]);
  // While any peer is paused, one click lets every paused profile pair again.
  button(root, "Pair with other profiles")?.click();
  await expect.poll(() => peer.asked("pair-again")).toEqual([{ type: "pair-again" }]);
});

test("a session in one peer blocks Record in the others' lists", async () => {
  const theirs = { status: "recording" as const, mine: false, live: true };
  const peer = fakePeerClient(withCarol(withPeerSession(statusOf("connected"), theirs)));
  const { root } = mount(peer);
  await expect
    .poll(() => notes(root))
    .toEqual(["Recording in Bob", "Recording in Bob", "Recording in Bob"]);
  expect(buttons(item(root, "Shop"))).toEqual([]);
  expect(buttons(item(remote(root, "Bob") ?? root, "Mail"))).toEqual(["Show tab"]);
  expect(buttons(item(remote(root, "Carol") ?? root, "Notes"))).toEqual(["Show tab"]);

  // This profile controls the session in Bob: Bob's list is its own, Carol's still waits.
  peer.change(withCarol(withPeerSession(statusOf("connected"), { ...theirs, mine: true })));
  await expect.poll(() => note(remote(root, "Bob"))).toBeUndefined();
  expect(note(remote(root, "Carol"))).toBe("Recording in Bob");
  expect(buttons(item(remote(root, "Carol") ?? root, "Notes"))).toEqual(["Show tab"]);
});
