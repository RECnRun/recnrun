import { describe, expect, test } from "vite-plus/test";
import { useFixture } from "./harness.ts";

const fixture = useFixture();
const call = (path: string, init?: RequestInit) => fetch(`${fixture.urls.first}${path}`, init);

const order = (fields: Record<string, string>, init: RequestInit = {}) =>
  call("/api/orders", {
    method: "POST",
    body: new URLSearchParams(fields),
    redirect: "manual",
    ...init,
  });

async function countOf(key: string): Promise<number> {
  const response = await call(`/api/orders?key=${encodeURIComponent(key)}`);
  return ((await response.json()) as { count: number }).count;
}

describe("orders", () => {
  test("counts an order at once and confirms it only after the delay", async () => {
    const started = Date.now();
    const answer = order({ key: "slow", delay: "400" });
    await expect.poll(() => countOf("slow")).toBe(1);
    const response = await answer;
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/routes/replay?order=slow&placed=slow");
    expect(await countOf("slow")).toBe(1);
  });

  test("keeps the order of a client that leaves before the answer", async () => {
    const leave = new AbortController();
    const answer = order({ key: "left", delay: "5000" }, { signal: leave.signal });
    await expect.poll(() => countOf("left")).toBe(1);
    leave.abort();
    await expect(answer).rejects.toThrow();
    expect(await countOf("left")).toBe(1);
  });

  test("counts each key on its own, with a default key and no delay", async () => {
    await order({ key: "a b" });
    await order({ key: "a b", delay: "soon" });
    const response = await order({});
    expect(response.headers.get("location")).toBe("/routes/replay?order=default&placed=default");
    expect(await countOf("a b")).toBe(2);
    expect(await countOf("default")).toBe(1);
    expect(await countOf("never")).toBe(0);
    expect(await (await call("/api/orders")).json()).toEqual({ key: "default", count: 1 });
  });

  test("rejects a body over 4 KiB and methods other than GET, HEAD, and POST", async () => {
    expect((await order({ key: "x".repeat(5_000) })).status).toBe(413);
    expect(await countOf("x".repeat(5_000))).toBe(0);
    const put = await call("/api/orders", { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, HEAD, POST");
  });
});
