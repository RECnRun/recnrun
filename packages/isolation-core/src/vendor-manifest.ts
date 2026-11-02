import * as v from "valibot";

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

const VendorManifestSchema = v.object({
  repository: v.string(),
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
  license: v.string(),
  files: v.record(v.string(), Sha256Schema),
});

export type VendorManifest = v.InferOutput<typeof VendorManifestSchema>;

export function parseVendorManifest(json: string): VendorManifest {
  return v.parse(VendorManifestSchema, JSON.parse(json));
}
