/**
 * The port each site tab's content script opens once its dashboard frame loads. Every dashboard
 * frame holds it, so it disconnects only when RECnRun reloads or turns off.
 */
export const SITE_PORT = "recnrun-site";

export interface SitePort {
  name: string;
  onDisconnect: { addListener: (listener: () => void) => void };
}
