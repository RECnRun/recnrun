import type { PairingPreview } from "@/messaging/peer-results";
import { BOB } from "./fake-peer-client";
import { button } from "./queries";

/** What the pairing page shows as typed by the user and read back by a test. */
export const statusText = (root: ParentNode) => root.querySelector('[role="status"]')?.textContent;
export const alerts = (root: ParentNode) =>
  [...root.querySelectorAll('[role="alert"]')].map((each) => each.textContent);
export const field = (root: ParentNode, id: string) =>
  root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`) ?? undefined;
export const check = (root: ParentNode) =>
  root.querySelector('dl[aria-label="Pairing check"]')?.textContent;
export const disabled = (root: ParentNode, name: string) => button(root, name)?.disabled;

/** Types as the user would, and waits for the render, so the next click sees the text. */
export async function type(
  target: HTMLInputElement | HTMLTextAreaElement | undefined,
  text: string,
) {
  if (!target) throw new Error("Nothing to type into.");
  target.value = text;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve));
}

/** What the background shows of a code Bob made. */
export const previewOf = (kind: PairingPreview["kind"], known = false): PairingPreview => ({
  kind,
  ...BOB,
  digits: "042917",
  known,
});
