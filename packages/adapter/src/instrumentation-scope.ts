/** What an attach event says about the target and where it was attached. */
export interface AttachSite {
  targetId: string;
  type: string;
  openerId?: string | undefined;
  /** Whether the target was attached through an instrumented target's session (a frame or worker). */
  viaInstrumented: boolean | undefined;
}

/**
 * The pages a recording session opened and the pages they open; a session never captures the
 * person's other tabs. Frames and workers belong to the page whose session attached them.
 */
export class TargetScope {
  private readonly pages: Set<string>;

  constructor(roots: Iterable<string>) {
    this.pages = new Set(roots);
  }

  /** A page another connection opened (replay's Playwright), attached to explicitly. */
  add(targetId: string): void {
    this.pages.add(targetId);
  }

  admits(site: AttachSite): boolean {
    if (site.viaInstrumented !== undefined) return site.viaInstrumented;
    if (site.type !== "page") return false;
    const opened = site.openerId !== undefined && this.pages.has(site.openerId);
    if (!opened && !this.pages.has(site.targetId)) return false;
    this.pages.add(site.targetId);
    return true;
  }
}
