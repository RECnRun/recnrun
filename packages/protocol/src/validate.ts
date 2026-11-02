import * as v from "valibot";
import { NonEmptyStringSchema } from "./common.ts";
import { FlowSchema } from "./flow.ts";
import {
  type IssuePath,
  findCyclicVariables,
  findDuplicateStepIds,
  findMissingInputs,
  findUnknownStepKinds,
} from "./flow-checks.ts";
import { hasKnownNamespaces, hasWellFormedReferences } from "./interpolation.ts";
import { nthHasIndex } from "./locators.ts";

export const FLOW_ISSUE_CODES = [
  "invalid-schema",
  "unknown-action",
  "unknown-assertion",
  "unknown-builtin",
  "unknown-namespace",
  "invalid-interpolation",
  "nth-without-index",
  "duplicate-step-id",
  "missing-input",
  "cyclic-variable",
] as const;

/** A problem `validateFlow` found, at a path of keys and indexes from the flow's root. */
export const FlowIssueSchema = v.strictObject({
  code: v.picklist(FLOW_ISSUE_CODES),
  path: v.array(v.union([v.string(), v.number()])),
  message: NonEmptyStringSchema,
});

export const FlowValidationResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), flow: FlowSchema }),
  v.strictObject({ ok: v.literal(false), issues: v.array(FlowIssueSchema) }),
]);

export type FlowIssue = v.InferOutput<typeof FlowIssueSchema>;
export type FlowValidationResult = v.InferOutput<typeof FlowValidationResultSchema>;

// Schema checks that carry their own issue code instead of `invalid-schema`.
const CHECK_CODES = new Map<unknown, FlowIssue["code"]>([
  [hasKnownNamespaces, "unknown-namespace"],
  [hasWellFormedReferences, "invalid-interpolation"],
  [nthHasIndex, "nth-without-index"],
]);

type SchemaIssue = v.BaseIssue<unknown>;

function relativePath(issue: SchemaIssue): IssuePath {
  return (issue.path ?? []).map((item) => item.key as string | number);
}

/** Maps a Valibot issue to flow issues, preferring coded checks found inside a failed union. */
function toFlowIssues(issue: SchemaIssue, prefix: IssuePath): FlowIssue[] {
  const path = [...prefix, ...relativePath(issue)];
  const code = CHECK_CODES.get(issue.requirement);
  if (code) return [{ code, path, message: issue.message }];
  const coded = (issue.issues ?? [])
    .flatMap((nested) => toFlowIssues(nested, path))
    .filter((nested) => nested.code !== "invalid-schema");
  return coded.length > 0 ? coded : [{ code: "invalid-schema", path, message: issue.message }];
}

function startsWith(path: IssuePath, prefix: IssuePath): boolean {
  return prefix.every((key, index) => path[index] === key);
}

/** An issue on, inside, or around a step already reported as unknown repeats that report. */
function concernsStep(path: IssuePath, stepPath: IssuePath): boolean {
  return startsWith(path, stepPath) || startsWith(stepPath, path);
}

function unique(issues: FlowIssue[]): FlowIssue[] {
  const keys = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([issue.code, issue.path]);
    return keys.has(key) ? false : (keys.add(key), true);
  });
}

/** Validates a flow's shape and the rules a schema cannot express, before anything runs. */
export function validateFlow(input: unknown): FlowValidationResult {
  const kindIssues = findUnknownStepKinds(input);
  const parsed = v.safeParse(FlowSchema, input);
  if (!parsed.success) {
    const stepPaths = kindIssues.map((issue) => issue.path.slice(0, -1));
    const schemaIssues = parsed.issues
      .flatMap((issue) => toFlowIssues(issue, []))
      .filter((issue) => !stepPaths.some((stepPath) => concernsStep(issue.path, stepPath)));
    return { ok: false, issues: unique([...kindIssues, ...schemaIssues]) };
  }
  const flow = parsed.output;
  const issues = [
    ...findDuplicateStepIds(flow),
    ...findMissingInputs(flow),
    ...findCyclicVariables(flow),
  ];
  return issues.length > 0 ? { ok: false, issues } : { ok: true, flow };
}
