import * as v from "valibot";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { FINGERPRINT, PEER, PEER_IDENTITY } from "./fake-peer";

/** The schemas read again under another build mode, as WXT builds them. */
async function schemasIn(mode: string) {
  vi.stubEnv("MODE", mode);
  vi.resetModules();
  return import("@/messaging/peer-results");
}

const PAIRED = { profileId: PEER, displayName: "Profile B", fingerprint: FINGERPRINT };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("outside production an authorized peer holds the identity key that signed its certificate", async () => {
  const { AuthorizedPeerSchema } = await schemasIn("poc-d0");
  expect(v.parse(AuthorizedPeerSchema, { ...PAIRED, identity: PEER_IDENTITY })).toEqual({
    ...PAIRED,
    identity: PEER_IDENTITY,
  });
  expect(v.safeParse(AuthorizedPeerSchema, PAIRED).success).toBe(false);
});

test("production pairs with no one, so its authorized peer has no identity key", async () => {
  const { AuthorizedPeerSchema } = await schemasIn("production");
  expect(v.parse(AuthorizedPeerSchema, PAIRED)).toEqual(PAIRED);
  expect(v.safeParse(AuthorizedPeerSchema, { ...PAIRED, identity: PEER_IDENTITY }).success).toBe(
    false,
  );
});
