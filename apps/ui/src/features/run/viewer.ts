import {
  type Artifact,
  type Event,
  type SnapshotMilestone,
  type SnapshotPart,
  SnapshotPayloadSchema,
} from "@recnrun/protocol";
import { check } from "@/api/schema";

/** One milestone of one step: its serialized page and its screenshot. */
export interface SnapshotRow {
  key: string;
  stepId: string;
  milestone: SnapshotMilestone;
  url: string | undefined;
  dom: SnapshotPart;
  screenshot: SnapshotPart;
}

/** The snapshot events of a run as rows, in journal order; an event that does not parse is left out. */
export function snapshotRows(events: readonly Event[]): SnapshotRow[] {
  return events.flatMap((event) => {
    if (event.category !== "snapshot" || event.stepId === undefined) return [];
    const payload = check(SnapshotPayloadSchema, event.payload);
    if (!payload.ok) return [];
    const { milestone, url, dom, screenshot } = payload.value;
    return [{ key: event.id, stepId: event.stepId, milestone, url, dom, screenshot }];
  });
}

const REASONS: Record<string, string> = {
  "no-tab": "no tab was open",
  "over-cap": "over the size cap",
  "capture-failed": "the capture failed",
};

/** Why a part cannot be viewed, or undefined when it holds a blob. */
export function unavailable(part: SnapshotPart): string | undefined {
  return part.condition === "unavailable" ? (REASONS[part.reason] ?? part.reason) : undefined;
}

/** The part's blob hash, when there is one to fetch with `run.getArtifact`. */
export function blobOf(part: SnapshotPart): string | undefined {
  return part.condition === "unavailable" ? undefined : part.sha256;
}

/**
 * What the viewer document may do: nothing but render. It loads no script, frame, font, or
 * remote file, submits no form, and resolves no `<base>`; the iframe's empty sandbox backs it.
 */
export const VIEWER_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const escapeAttribute = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/** The captured HTML behind the viewer's own policy, which the parser reads before the page. */
export function viewerDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(VIEWER_CSP)}">`;
  // Markup ahead of the doctype would drop the page into quirks mode.
  const doctype = DOCTYPE.exec(html)?.[0] ?? "";
  return `${doctype}${doctype ? "\n" : ""}${policy}\n${html.slice(doctype.length)}`;
}

/** A screenshot as a `data:` URL the UI's own policy allows, or undefined for any other blob. */
export function imageSource(artifact: Artifact): string | undefined {
  if (artifact.mime !== "image/png" || artifact.encoding !== "binary") return undefined;
  return `data:image/png;base64,${artifact.data}`;
}
