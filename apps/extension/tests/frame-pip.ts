import { vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import type { DocumentPictureInPicture } from "@/pip/document-pip";

/** Stands in for the PiP window with a same-origin frame, whose document Preact can portal into. */
export interface Opened {
  window: Window;
  close: Mock<() => void>;
}

/** The PiP window opened n-th, failing the test when there is none. */
export function nth(opened: Opened[], index: number): Opened {
  const entry = opened[index];
  if (!entry) throw new Error(`No PiP window #${index} was opened.`);
  return entry;
}

export function framePip(): DocumentPictureInPicture & { opened: Opened[] } {
  const opened: Opened[] = [];
  return {
    window: null,
    opened,
    async requestWindow() {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const pipWindow = iframe.contentWindow;
      if (!pipWindow) throw new Error("The frame did not load.");
      const close = vi.fn(() => iframe.remove());
      pipWindow.close = close;
      opened.push({ window: pipWindow, close });
      return pipWindow;
    },
  };
}

export const refusingPip = (message: string): DocumentPictureInPicture => ({
  window: null,
  requestWindow: () => Promise.reject(new Error(message)),
});

export const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((each) => each.textContent === name);

export const panelText = (scope: ParentNode) =>
  scope.querySelector('section[aria-label="Recording panel"]')?.textContent;
