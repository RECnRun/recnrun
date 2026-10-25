import { expect } from "vite-plus/test";
import { panelClosedMessage } from "@/messaging/frame-protocol";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";

/** A dashboard frame stand-in whose parent, the site, is this test page. */
export function framedPage() {
  return Object.assign(new EventTarget(), {
    parent: window,
    document,
    location: { ancestorOrigins: [location.origin], search: "" },
  }) as unknown as Window;
}

/** What the site's content script would send the frame once the PiP window closes. */
export const closePanel = (page: Window) =>
  page.dispatchEvent(
    new MessageEvent("message", {
      data: panelClosedMessage(),
      origin: location.origin,
      source: window,
    }),
  );

export const item = (scope: ParentNode, title: string) =>
  scope.querySelector<HTMLElement>(`li[aria-label="${title}"]`) ?? undefined;
export const buttons = (scope: ParentNode | undefined) =>
  [...(scope?.querySelectorAll("button") ?? [])].map((each) => each.textContent);
export const alertText = (scope: ParentNode) => scope.querySelector('[role="alert"]')?.textContent;

/** Waits until no dashboard holds the control lock, which each test leaves free. */
export async function expectControlFree() {
  let release: (() => void) | undefined;
  await expect
    .poll(async () => {
      release = await tryHoldLock(CONTROL_LOCK);
      return release !== undefined;
    })
    .toBe(true);
  release?.();
}
