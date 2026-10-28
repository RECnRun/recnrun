import { expect } from "vite-plus/test";
import { CONTROL_LOCK, tryHoldLock } from "@/views/view-locks";

/** A window for the PiP API to hand out: a frame of this page, closed by removing it. */
export function pipWindow(): Window {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const opened = frame.contentWindow;
  if (!opened) throw new Error("The frame has no window.");
  opened.close = () => {
    opened.dispatchEvent(new Event("pagehide"));
    frame.remove();
  };
  return opened;
}

/** A dashboard tab stand-in, with the PiP API when `pip` is given. */
export function tabPage(hash: string, pip?: () => Promise<Window>) {
  const api = pip && { window: null, requestWindow: pip };
  return Object.assign(new EventTarget(), {
    document,
    history,
    location: { hash },
    documentPictureInPicture: api,
  }) as unknown as Window;
}

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
