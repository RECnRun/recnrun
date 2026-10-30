import { render } from "preact";
import { browser } from "wxt/browser";
import { dashboardUrl } from "@/config/origins";
import { createRequester } from "@/messaging/request";
import { Popup } from "@/popup/Popup";
import "@recnrun/brand/mona-sans.css";
import "@/popup/popup.css";

export function startPopup(): void {
  const send = createRequester((message) => browser.runtime.sendMessage(message));
  const root = document.getElementById("app");
  if (root) render(<Popup send={send} dashboardUrl={dashboardUrl(import.meta.env.MODE)} />, root);
}
