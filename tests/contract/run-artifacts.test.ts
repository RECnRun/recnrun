import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { RunningService } from "../../apps/service/src/index.ts";
import { command, send, startFresh, tempHome } from "./helpers.ts";
import { PNG, seedRuns } from "./run-seeds.ts";

const HTML = "<html><body><p data-testid=status>Not saved</p></body></html>";
const sha = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

let home = "";
let service: RunningService;
beforeAll(async () => {
  home = await tempHome();
  await seedRuns(home, { failed: { statusFails: true, snapshot: HTML }, plain: {} });
  service = await startFresh(home);
});
afterAll(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

const body = (params: Record<string, unknown>) => ({
  requestId: "r-1",
  command: "run.getArtifact",
  params,
});

async function call(params: Record<string, unknown>) {
  const response = await command(service, body(params));
  return response.json as { ok: boolean; result?: unknown; error?: { code: string } };
}

test("run.getArtifact answers the snapshot and screenshot a run's event references", async () => {
  expect(await call({ runId: "failed", sha256: sha(HTML) })).toEqual({
    ok: true,
    requestId: "r-1",
    result: {
      sha256: sha(HTML),
      mime: "text/html",
      encoding: "utf8",
      size: HTML.length,
      data: HTML,
    },
  });
  expect((await call({ runId: "failed", sha256: sha(PNG) })).result).toEqual({
    sha256: sha(PNG),
    mime: "image/png",
    encoding: "binary",
    size: PNG.length,
    data: PNG.toString("base64"),
  });
});

test("a blob of another run, or of no run, is not found", async () => {
  expect((await call({ runId: "plain", sha256: sha(HTML) })).error?.code).toBe("not-found");
  expect((await call({ runId: "failed", sha256: "0".repeat(64) })).error?.code).toBe("not-found");
  expect((await call({ runId: "missing", sha256: sha(HTML) })).error?.code).toBe("not-found");
});

test("refuses malformed, anonymous, or foreign requests", async () => {
  const traversal = await command(service, body({ runId: "failed", sha256: "../summary.json" }));
  expect(traversal.status).toBe(400);
  const valid = body({ runId: "failed", sha256: sha(HTML) });
  expect((await send(service.port, { body: JSON.stringify(valid) })).status).toBe(401);
  expect((await command(service, valid, { origin: "https://evil.example" })).status).toBe(403);
});
