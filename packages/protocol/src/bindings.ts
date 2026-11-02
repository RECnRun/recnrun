import * as v from "valibot";
import { IsoTimestampSchema, NonEmptyStringSchema } from "./common.ts";

/** The version of `~/.recnrun/bindings.json`; a breaking change bumps it and adds a migration. */
export const BINDINGS_SCHEMA_VERSION = 1;

/** How a stored binding compares with what discovery and the handshake find now. */
export const BINDING_STATUSES = ["fresh", "stale-restarted", "stale-missing"] as const;

/** What changed since a binding was last seen: the browser endpoint path or the Chrome version. */
export const BINDING_CHANGES = ["endpoint", "chrome"] as const;

/** A friendly name the user chooses, such as `Ana (approver)`; no surrounding spaces. */
export const BindingNameSchema = v.pipe(
  v.string(),
  v.regex(/^\S(?:.{0,78}\S)?$/, "A binding name has 1 to 80 characters and no surrounding spaces."),
);

/** The WebSocket of a Chrome found through its DevToolsActivePort. */
const BrowserEndpointSchema = v.pipe(
  v.string(),
  v.regex(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//),
);

/** What a live connection tells about the profile behind it. */
export const ProfileDescriptionSchema = v.strictObject({
  userDataDir: NonEmptyStringSchema,
  // Contexts the connection observed: the default one and any Target.createBrowserContext made.
  browserContextIds: v.array(NonEmptyStringSchema),
  // `Browser.getVersion` product, such as `Chrome/156.0.8078.79`.
  chrome: NonEmptyStringSchema,
});

/** A local binding of a Chrome profile to a friendly name; it never travels inside a flow. */
export const ProfileBindingSchema = v.strictObject({
  name: BindingNameSchema,
  ...ProfileDescriptionSchema.entries,
  // The endpoint last seen; a restarted Chrome answers on another one.
  wsEndpoint: BrowserEndpointSchema,
  createdAt: IsoTimestampSchema,
  lastSeenAt: IsoTimestampSchema,
});

const uniqueNames = (bindings: { name: string }[]): boolean =>
  new Set(bindings.map(({ name }) => name)).size === bindings.length;

/** `~/.recnrun/bindings.json`: every binding of this user, names unique. */
export const BindingsFileSchema = v.strictObject({
  schemaVersion: v.literal(BINDINGS_SCHEMA_VERSION),
  bindings: v.pipe(
    v.array(ProfileBindingSchema),
    v.check((bindings) => uniqueNames(bindings), "Binding names are unique."),
  ),
});

/** A binding is reported stale, never silently remapped to whatever Chrome answers now. */
export const BindingClassificationSchema = v.variant("status", [
  v.strictObject({ status: v.literal("fresh"), wsEndpoint: BrowserEndpointSchema }),
  v.strictObject({
    status: v.literal("stale-restarted"),
    wsEndpoint: BrowserEndpointSchema,
    changed: v.pipe(v.array(v.picklist(BINDING_CHANGES)), v.minLength(1)),
  }),
  v.strictObject({ status: v.literal("stale-missing"), remedy: NonEmptyStringSchema }),
]);

export type BindingName = v.InferOutput<typeof BindingNameSchema>;
export type ProfileDescription = v.InferOutput<typeof ProfileDescriptionSchema>;
export type ProfileBinding = v.InferOutput<typeof ProfileBindingSchema>;
export type BindingsFile = v.InferOutput<typeof BindingsFileSchema>;
export type BindingStatus = (typeof BINDING_STATUSES)[number];
export type BindingChange = (typeof BINDING_CHANGES)[number];
export type BindingClassification = v.InferOutput<typeof BindingClassificationSchema>;

export type BindingsFileParse = { ok: true; file: BindingsFile } | { ok: false; message: string };

/** Validates a parsed `bindings.json`, so persistence reads it without importing Valibot. */
export function parseBindingsFile(input: unknown): BindingsFileParse {
  const parsed = v.safeParse(BindingsFileSchema, input);
  if (parsed.success) return { ok: true, file: parsed.output };
  return { ok: false, message: v.summarize(parsed.issues) };
}
