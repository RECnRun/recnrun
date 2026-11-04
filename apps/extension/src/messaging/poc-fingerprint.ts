import * as v from "valibot";
import { FingerprintSchema } from "@/p2p/protocol";

/** The background asks the offscreen document, which holds the certificate, for its fingerprint. */
export const PocFingerprintRequestSchema = v.strictObject({ type: v.literal("POC_FINGERPRINT") });

export const pocFingerprintRequest = (): v.InferOutput<typeof PocFingerprintRequestSchema> => ({
  type: "POC_FINGERPRINT",
});

export const PocFingerprintResultSchema = v.strictObject({ fingerprint: FingerprintSchema });
