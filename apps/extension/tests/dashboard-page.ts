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
