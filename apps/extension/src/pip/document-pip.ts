import { subscribeFrame } from "@/messaging/frame-channel";

/** Document Picture-in-Picture, which TypeScript's DOM types do not describe yet. */
export interface DocumentPictureInPicture {
  readonly window: Window | null;
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

// Chrome treats the size as a hint and keeps the window above a minimum.
const PANEL_WINDOW_SIZE = { width: 360, height: 300 };

/** The page's PiP API, missing outside Chromium and in frames' types. */
export function documentPip(page: Window): DocumentPictureInPicture | undefined {
  return (page as Window & { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;
}

/** Needs the user activation of a click, which lasts a few seconds, so call it right after one. */
export function requestPanelWindow(pip: DocumentPictureInPicture): Promise<Window> {
  return pip.requestWindow(PANEL_WINDOW_SIZE);
}

/** The PiP window starts blank, so it gets the opener's stylesheets, with absolute addresses. */
export function copyStyles(from: Document, to: Document): void {
  for (const sheet of from.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')) {
    const copy = sheet.cloneNode(true) as HTMLElement;
    if (sheet instanceof HTMLLinkElement) copy.setAttribute("href", sheet.href);
    to.head.append(copy);
  }
}

/** Fills a PiP window with a frame of the session page, which closes the window when it ends. */
export function showSession(pipWindow: Window, sessionUrl: string, extensionOrigin: string): void {
  const { document } = pipWindow;
  const iframe = document.createElement("iframe");
  iframe.title = "RECnRun session";
  iframe.src = sessionUrl;
  Object.assign(iframe.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    border: "0",
  });
  document.body.append(iframe);
  subscribeFrame(pipWindow, iframe.contentWindow, extensionOrigin, {
    "close-panel": () => pipWindow.close(),
  });
}
