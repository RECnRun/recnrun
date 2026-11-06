import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startPocFingerprint } from "@/offscreen/poc-fingerprint";

const background = {
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL("/background.js"),
};
const page = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/dashboard.html") };

/** A certificate as the offscreen document holds it, with the fingerprints given. */
const certificateWith = (fingerprints: { algorithm: string; value: string }[]) => async () =>
  ({ getFingerprints: () => fingerprints }) as unknown as RTCCertificate;

/** Delivers one message; resolves with the reply, or "ignored" when the listener declined it. */
async function ask(message: unknown, sender: { id: string; url: string }) {
  const replies: unknown[] = [];
  const [handled]: unknown[] = await fakeBrowser.runtime.onMessage.trigger(
    message,
    sender,
    (reply: unknown) => replies.push(reply),
  );
  if (handled !== true) return "ignored";
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  return replies[0];
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe("startPocFingerprint", () => {
  test("gives the background the SHA-256 fingerprint of the links' certificate, upper case", async () => {
    startPocFingerprint({
      certificate: certificateWith([
        { algorithm: "sha-1", value: "00:00" },
        { algorithm: "sha-256", value: "ab:cd:ef" },
      ]),
    });
    expect(await ask({ type: "POC_FINGERPRINT" }, background)).toEqual({
      ok: true,
      result: { fingerprint: "AB:CD:EF" },
    });
  });

  test("answers no page and no other message", async () => {
    const certificate = vi.fn(certificateWith([{ algorithm: "sha-256", value: "ab" }]));
    startPocFingerprint({ certificate });
    expect(await ask({ type: "POC_FINGERPRINT" }, page)).toBe("ignored");
    expect(await ask({ type: "POC_FINGERPRINT", extra: 1 }, background)).toBe("ignored");
    expect(certificate).not.toHaveBeenCalled();
  });

  test("reports a certificate with no SHA-256 fingerprint as an error", async () => {
    startPocFingerprint({ certificate: certificateWith([{ algorithm: "sha-1", value: "00" }]) });
    expect(await ask({ type: "POC_FINGERPRINT" }, background)).toEqual({
      ok: false,
      error: "The certificate has no SHA-256 fingerprint.",
    });
  });
});
