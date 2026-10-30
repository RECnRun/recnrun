import { expect, test } from "vite-plus/test";
import { controlFrom } from "@/dashboard/control";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { PageRequest } from "@/views/extension-services";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";
import { closePanel, framedPage } from "./framed-page";

/** A background that accepts a session and refuses to give the focus back. */
function refusingFocus() {
  const sent: PageRequest[] = [];
  const send = async (request: PageRequest) => {
    sent.push(request);
    return request.type === "return-to-dashboard"
      ? { ok: false as const, error: "The site tab is gone." }
      : { ok: true as const };
  };
  return { send, sent };
}

async function controlIsFree() {
  const release = await tryHoldLock(CONTROL_LOCK);
  release?.();
  return release !== undefined;
}

test("a PiP window this dashboard did not open closing asks for nothing", async () => {
  const { send, sent } = refusingFocus();
  const page = framedPage();
  controlFrom(page, location.origin, send);
  closePanel(page);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
  expect(await controlIsFree()).toBe(true);
});

test("a focus the background cannot give back still frees the control, silently", async () => {
  const { send, sent } = refusingFocus();
  const page = framedPage();
  const take = controlFrom(page, location.origin, send);
  await take(7);
  expect(await tryHoldLock(CONTROL_LOCK)).toBeUndefined();
  closePanel(page);
  await expect.poll(() => sent).toEqual([startSessionMessage(7), returnToDashboardMessage()]);
  await expect.poll(controlIsFree).toBe(true);
});
