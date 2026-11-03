import { MarkerSchema } from "@recnrun/isolation-core";
import * as v from "valibot";
import { isLoopbackUrl } from "@/background/probes/loopback";
import { SELECTIONS } from "@/background/route-b/select";
import { SelectRequest } from "@/background/selection/requests";

/** The `chrome.storage.managed` key the strict lab's policy sets (E8); without it the lab stays off. */
export const LAB_KEY = "lab";

/** The tab id goes after the marker prefix, so the whole marker still fits `MarkerSchema`. */
const MARKER_PREFIX_MAX = 48;

function isLabUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname } = new URL(value);
  return protocol === "http:" && hostname.endsWith(".localhost");
}

function isLoopbackOrigin(value: string): boolean {
  return isLoopbackUrl(value) && new URL(value).origin === value;
}

const OriginSchema = v.pipe(v.string(), v.check(isLoopbackOrigin, "expected a loopback origin"));

// The managed value comes from a policy file, so it is checked where it enters like any message.
const LabConfigSchema = v.object({
  /** Where the isolator posts its `loaded` beacon and its journal; the harness's loopback server. */
  journalUrl: v.pipe(v.string(), v.check(isLabUrl, "journalUrl must be http://<name>.localhost")),
  /** Prefix of each armed tab's marker, `<marker>-t<tabId>`. */
  marker: v.optional(v.pipe(MarkerSchema, v.maxLength(MARKER_PREFIX_MAX)), "lab"),
  /** Arms every tab once it has loaded a page of `origin`. */
  arm: v.optional(
    v.object({
      origin: OriginSchema,
      pauseBeforeScript: v.boolean(),
      /** Route A (auto-attach and bootstrap) or Route B (wrapped scripts, E5 and E6). */
      route: v.optional(v.picklist(["a", "b"]), "a"),
      /** Clears the origin's service workers, IndexedDB, and Cache Storage right after arming. */
      clear: v.optional(v.boolean(), false),
      /** Route B's `Fetch.enable` pattern. */
      urlPattern: v.optional(v.pipe(v.string(), v.minLength(1)), "*"),
      /** Route B's E6 selection wrapper. */
      selection: v.optional(v.picklist(SELECTIONS)),
    }),
  ),
  /** The slot the selection's session rules point at; applied whenever the value changes. */
  selection: v.optional(SelectRequest),
  /** Closes every worker target of `origin` once per new `id`, as E3's `closeTarget` does. */
  stop: v.optional(v.object({ id: v.pipe(v.string(), v.minLength(1)), origin: OriginSchema })),
  /** How often the journal is compared and posted when it changed. */
  pollMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(50), v.maxValue(5_000)), 200),
});

export type LabConfig = v.InferOutput<typeof LabConfigSchema>;

/** The lab's settings in what `storage.managed.get()` returned; `undefined` when the key is absent. */
export function labConfigOf(stored: Record<string, unknown>): LabConfig | undefined {
  const value = stored[LAB_KEY];
  if (value === undefined) return undefined;
  const result = v.safeParse(LabConfigSchema, value);
  if (result.success) return result.output;
  throw new Error(`invalid managed ${LAB_KEY}: ${v.summarize(result.issues)}`);
}
