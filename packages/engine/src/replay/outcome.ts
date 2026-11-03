/** How a running step ended, before timestamps and redaction. */
export interface StepOutcome {
  status: "passed" | "failed" | "indeterminate";
  attempts?: number | undefined;
  error?: { code: string; message: string } | undefined;
  evidence?: string[] | undefined;
}

/** A failure the executor raises itself before anything was dispatched, with its code. */
export class StepFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StepFailure";
    this.code = code;
  }
}

/** Failure codes that blame the application under test (exit 1); any other code is a run error. */
export const APPLICATION_FAILURES: ReadonlySet<string> = new Set([
  "assertion-failed",
  "timeout",
  "ambiguous",
  "navigation-failed",
  "not-actionable",
]);

export const quoted = (label: string, text: string): string => `${label}: ${JSON.stringify(text)}`;

export function passed(attempts?: number, evidence?: string[]): StepOutcome {
  return { status: "passed", ...(attempts && { attempts }), ...(evidence && { evidence }) };
}

export function failed(code: string, message: string, attempts?: number): StepOutcome {
  return { status: "failed", error: { code, message }, ...(attempts && { attempts }) };
}

/** Maps anything a step threw to a failure; a write never reaches here once dispatched. */
export function failure(error: unknown): StepOutcome {
  const code = error instanceof StepFailure ? error.code : "adapter-error";
  const message = (error instanceof Error ? error.message : String(error)) || "Unknown error.";
  return failed(code, message);
}
