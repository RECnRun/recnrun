import type {
  DivergenceKind,
  DivergenceSide,
  RunComparison,
  RunDivergence,
} from "@recnrun/protocol";
import type { Tone } from "@/ui/Badge";

/** Whom the first divergence points at; a collector gap is never the application's. */
const VERDICTS: Record<DivergenceKind, { verdict: string; tone: Tone }> = {
  application: { verdict: "Application failure", tone: "danger" },
  "collector-gap": { verdict: "Collector gap", tone: "neutral" },
  replay: { verdict: "Replay problem", tone: "danger" },
};

const REASONS: Record<RunDivergence["reason"], string> = {
  "step-status": "step status",
  "assertion-failed": "failed assertion",
  "network-status": "response status",
  "collector-gap": "lost events",
};

const GAP_NOTE =
  "Not an application failure: the collector lost events, so what happened then is unknown.";

export interface ComparisonRow {
  stepId: string;
  baseline: string;
  run: string;
  first: boolean;
}

export interface ComparisonView {
  verdict: string;
  tone: Tone;
  headline: string | undefined;
  message: string | undefined;
  sides: string[];
  notes: string[];
  rows: ComparisonRow[];
}

function sideText(side: DivergenceSide): string | undefined {
  if (side.gap) {
    const { reason, surface, lost } = side.gap;
    const where = surface ? ` on ${surface}` : "";
    const count = lost === undefined ? "" : `, ${lost} ${lost === 1 ? "event" : "events"} lost`;
    return `lost events: ${reason}${where}${count}`;
  }
  if (side.httpStatus !== undefined) return `${side.httpStatus} ${side.url ?? ""}`.trim();
  const error = side.error ? `, ${side.error.message} (${side.error.code})` : "";
  return side.status ? `${side.status}${error}` : undefined;
}

function sidesOf({ baseline, run }: RunDivergence): string[] {
  const texts = [
    ["Baseline", sideText(baseline)],
    ["This run", sideText(run)],
  ];
  return texts.flatMap(([label, text]) => (text ? [`${label}: ${text}`] : []));
}

function headlineOf(divergence: RunDivergence, total: number): string {
  const reason = REASONS[divergence.reason];
  if (divergence.stepId === undefined) return `First divergence before any step: ${reason}`;
  const place = divergence.index === undefined ? "" : ` (step ${divergence.index + 1} of ${total})`;
  return `First divergence at step ${divergence.stepId}${place}: ${reason}`;
}

/** What the comparison says, in the words the Compare card shows. */
export function comparisonView(comparison: RunComparison): ComparisonView {
  const { divergence, steps } = comparison;
  const notes = comparison.sameRevision ? [] : ["The runs replay different revisions of the flow."];
  const rows = steps.map(({ stepId, baseline, run }) => ({
    stepId,
    baseline: baseline ?? "not reached",
    run: run ?? "not reached",
    first: divergence?.stepId === stepId,
  }));
  if (!divergence) {
    const verdict = { verdict: "No observable divergence", tone: "success" as const };
    return { ...verdict, headline: undefined, message: undefined, sides: [], notes, rows };
  }
  if (divergence.kind === "collector-gap") notes.unshift(GAP_NOTE);
  return {
    ...VERDICTS[divergence.kind],
    headline: headlineOf(divergence, steps.length),
    message: divergence.message,
    sides: sidesOf(divergence),
    notes,
    rows,
  };
}
