import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { pairRequests } from "@/features/diagnostics/pairing";
import { Requests } from "@/features/diagnostics/Requests";
import { storageRows } from "@/features/diagnostics/storage-rows";
import { StorageOperations } from "@/features/diagnostics/StorageOperations";
import { expectTexts, fakeApi, renderWith } from "./fake-api";
import { runEvent } from "./run-events";

const JSON_URL = "http://127.0.0.1:4600/api/json";
const SHA = "f".repeat(64);
const at = (second: number, ms = 0) =>
  `2026-11-02T10:00:${String(second).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;

const network = (type: string, payload: Record<string, unknown>, second: number, ms = 0) =>
  runEvent("network", type, payload, { timestamp: at(second, ms), stepId: "submit" });

const REQUESTS = [
  network("request", { requestId: "r-1", url: JSON_URL, method: "GET" }, 1),
  network(
    "request",
    { requestId: "r-2", url: "http://127.0.0.1:4600/api/abort", method: "GET" },
    1,
  ),
  network(
    "response",
    {
      requestId: "r-1",
      url: JSON_URL,
      status: 500,
      statusText: "Internal",
      mimeType: "application/json",
    },
    1,
    40,
  ),
  network("finished", { requestId: "r-1", encodedDataLength: 120 }, 1, 125),
  network(
    "body",
    {
      requestId: "r-1",
      url: JSON_URL,
      condition: "captured",
      blob: {
        sha256: SHA,
        mime: "application/json",
        encoding: "utf8",
        size: 60,
        condition: "captured",
      },
    },
    1,
    130,
  ),
  network("failed", { requestId: "r-2", errorText: "net::ERR_EMPTY_RESPONSE", canceled: false }, 2),
  // A response whose request the capture never saw still gets its own row.
  network(
    "response",
    {
      requestId: "r-3",
      url: "http://127.0.0.1:4601/logo.png",
      status: 200,
      statusText: "",
      mimeType: "image/png",
    },
    3,
  ),
  network("body", { requestId: "r-3", url: "x", condition: "unavailable", reason: "evicted" }, 3),
  network("websocket-closed", { requestId: "ws-1" }, 4),
];

const storage = (type: string, payload: Record<string, unknown>) =>
  runEvent("storage", type, payload, { timestamp: at(5) });

const STORAGE = [
  storage("snapshot", {
    observation: "snapshot",
    reason: "attach",
    area: "local",
    storageKey: "http://127.0.0.1:4600/",
    items: [{ key: "theme", value: "dark" }],
  }),
  storage("operation", {
    observation: "observed-operation",
    area: "session",
    operation: "setItem",
    key: "cart",
    value: "3",
  }),
  storage("item-updated", {
    observation: "observed-change",
    area: "local",
    storageKey: "http://127.0.0.1:4600/",
    key: "theme",
    oldValue: "dark",
    newValue: "light",
  }),
  storage("cookie-added", {
    observation: "observed-change",
    cookie: {
      name: "sid",
      domain: "127.0.0.1",
      path: "/",
      redacted: true,
      httpOnly: true,
      secure: false,
      session: true,
    },
  }),
  storage("operation", { observation: "sideways" }),
];

describe("request and response pairing", () => {
  test("makes one row per request with its response, timing, failure, and body references", () => {
    expect(pairRequests(REQUESTS)).toEqual([
      expect.objectContaining({
        requestId: "r-1",
        method: "GET",
        url: JSON_URL,
        status: 500,
        outcome: "500 Internal",
        durationMs: 125,
        stepId: "submit",
        bodies: [{ condition: "captured", mime: "application/json", size: 60, sha256: SHA }],
      }),
      expect.objectContaining({
        requestId: "r-2",
        outcome: "failed: net::ERR_EMPTY_RESPONSE",
        durationMs: 1000,
        bodies: [],
      }),
      expect.objectContaining({
        requestId: "r-3",
        method: undefined,
        url: "http://127.0.0.1:4601/logo.png",
        outcome: "200",
        durationMs: undefined,
        bodies: [{ condition: "unavailable", reason: "evicted" }],
      }),
    ]);
  });

  test("leaves a request with no answer pending", () => {
    const [row] = pairRequests([REQUESTS[0] as never]);
    expect(row).toMatchObject({ outcome: "no response recorded", durationMs: undefined });
  });
});

describe("storage operations", () => {
  test("labels each by how the capture knows it, and keeps cookie values it never had out", () => {
    expect(storageRows(STORAGE).map(({ observation, detail }) => [observation, detail])).toEqual([
      ["snapshot", "local http://127.0.0.1:4600/: 1 item"],
      ["observed operation", "sessionStorage.setItem(cart, 3)"],
      ["observed change", "local theme: dark → light"],
      ["observed change", "cookie sid added (value redacted)"],
    ]);
  });
});

function renderEvidence(ui: preact.JSX.Element) {
  const fake = fakeApi({
    "run.queryEvents": (params) => ({
      events:
        params.category === "network" ? REQUESTS : params.category === "storage" ? STORAGE : [],
    }),
  });
  renderWith(fake.api, ui);
  return fake;
}

describe("the evidence cards", () => {
  test("lists paired requests with their status and body references, never the body", async () => {
    const fake = renderEvidence(<Requests runId="run-1" />);
    const table = page.getByRole("table", { name: "Requests" });
    await expectTexts(table, "GET", JSON_URL, "500 Internal", "125 ms", "captured", "60 bytes");
    await expectTexts(table, "failed: net::ERR_EMPTY_RESPONSE", "unavailable (evicted)");
    expect(fake.paramsOf("run.queryEvents")).toEqual([
      { runId: "run-1", category: "network", limit: 1000 },
    ]);
  });

  test("lists storage operations with their transaction state", async () => {
    renderEvidence(<StorageOperations runId="run-1" />);
    const list = page.getByRole("list", { name: "Storage operations" });
    await expectTexts(
      list,
      "snapshot",
      "observed operation",
      "observed change",
      "sessionStorage.setItem(cart, 3)",
    );
    await expectTexts(list, "cookie sid added (value redacted)");
  });

  test("says when the run recorded no request or storage operation", async () => {
    const fake = fakeApi({ "run.queryEvents": () => ({ events: [] }) });
    renderWith(
      fake.api,
      <>
        <Requests runId="run-1" />
        <StorageOperations runId="run-1" />
      </>,
    );
    await expectTexts(page.getByText("This run recorded no network request."), "network request");
    await expectTexts(page.getByText("This run recorded no storage operation."), "storage");
  });
});
