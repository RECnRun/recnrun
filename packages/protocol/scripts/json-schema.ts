import { toJsonSchema } from "@valibot/to-json-schema";
import { format } from "oxfmt";
import type * as v from "valibot";
import {
  AdapterEventSchema,
  BindingsFileSchema,
  BrowserHandshakeSchema,
  CapabilityMatrixSchema,
  DiscoveryResultSchema,
  EventSchema,
  FlowSchema,
  InstrumentationEventSchema,
  InstrumentationReportSchema,
  LocatorEntrySchema,
  ObserverMessageSchema,
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  RunCoverageSchema,
  RunManifestSchema,
  RunStepsSchema,
  RunSummarySchema,
  StepSchema,
  TargetSchema,
} from "../src/index.ts";

type AnySchema = v.GenericSchema;

/** Every top-level document of the protocol, by the file name its JSON Schema is written to. */
const DOCUMENTS: Record<string, AnySchema> = {
  "adapter-event": AdapterEventSchema,
  "bindings-file": BindingsFileSchema,
  "browser-handshake": BrowserHandshakeSchema,
  "capability-matrix": CapabilityMatrixSchema,
  "discovery-result": DiscoveryResultSchema,
  event: EventSchema,
  flow: FlowSchema,
  "instrumentation-event": InstrumentationEventSchema,
  "instrumentation-report": InstrumentationReportSchema,
  "observer-message": ObserverMessageSchema,
  "run-coverage": RunCoverageSchema,
  "run-manifest": RunManifestSchema,
  "run-steps": RunStepsSchema,
  "run-summary": RunSummarySchema,
  "service-request": RequestEnvelopeSchema,
  "service-response": ResponseEnvelopeSchema,
};

// Named definitions give the flow's recursive schemas stable $ref names instead of generated ones.
const DEFINITIONS: Record<string, AnySchema> = {
  Locator: LocatorEntrySchema,
  Step: StepSchema,
  Target: TargetSchema,
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
}

/** Renders each document's JSON Schema as the formatted text committed under schema/. */
export async function renderJsonSchemas(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [name, schema] of Object.entries(DOCUMENTS)) {
    const file = `${name}.schema.json`;
    // Semantic checks (`v.check`) have no JSON Schema equivalent; validateFlow enforces them.
    const definitions = schema === FlowSchema ? DEFINITIONS : {};
    const json = toJsonSchema(schema, { definitions, ignoreActions: ["check"] });
    const result = await format(file, `${JSON.stringify(sortKeys(json), null, 2)}\n`);
    if (result.errors.length > 0) throw new Error(`Cannot format ${file}`);
    files.set(file, result.code);
  }
  return files;
}
