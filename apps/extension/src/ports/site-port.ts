/** The port a site tab's content script opens; the content script only needs to know when it drops. */
export interface SitePort {
  name: string;
  onDisconnect: { addListener: (listener: () => void) => void };
}
