import type { BrowserAdapter } from "@recnrun/engine";
import type { Browser } from "playwright-core";

/** The Playwright browser a connected adapter holds once F1 implements the connection. */
export type CdpBrowser = Browser;

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet.`);
    this.name = "NotImplementedError";
  }
}

/** The CDP adapter; F1 connects it to Chrome through DevToolsActivePort. */
export function createCdpAdapter(): BrowserAdapter {
  return {
    connect: () => Promise.reject(new NotImplementedError("Connecting over CDP")),
    disconnect: () => Promise.reject(new NotImplementedError("Disconnecting from CDP")),
  };
}
