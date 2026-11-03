import { PassThrough } from "node:stream";
import { describe, expect, test } from "vite-plus/test";
import { CdpDetachedError, connectPipe } from "./browser/fixtures/cdp-client.ts";

// A reinstall replaces the extension's worker; Chrome then never answers a command sent to it.
describe("CDP client sessions", () => {
  test("rejects the commands of a session whose target detached, and only those", async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const client = connectPipe(toChrome, fromChrome);
    const stale = client.send("Browser.getVersion", {}, "stale-worker", { timeoutMs: 2_000 });
    const live = client.send("Browser.getVersion", {}, "live-worker", { timeoutMs: 2_000 });
    const detached = { method: "Target.detachedFromTarget", params: { sessionId: "stale-worker" } };
    fromChrome.write(`${JSON.stringify(detached)}\0`);
    await expect(stale).rejects.toBeInstanceOf(CdpDetachedError);
    fromChrome.write(`${JSON.stringify({ id: 2, result: { product: "Chrome/156" } })}\0`);
    await expect(live).resolves.toEqual({ product: "Chrome/156" });
    client.close();
  });
});
