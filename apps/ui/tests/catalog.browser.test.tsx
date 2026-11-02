import type { FlowCatalogEntry } from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { Catalog } from "@/features/catalog/Catalog";
import { NOW, expectTexts, REVISION, fakeApi, renderWith } from "./fake-api";

const FLOWS: FlowCatalogEntry[] = [
  { id: "login", name: "Log in", status: "recorded", revision: REVISION, updatedAt: NOW },
  { id: "order", name: "Place an order", status: "validated", revision: REVISION, updatedAt: NOW },
];

function renderCatalog(flows: () => Promise<{ flows: FlowCatalogEntry[] }>) {
  const onOpen = vi.fn<(flowId: string) => void>();
  const onRecord = vi.fn<() => void>();
  renderWith(fakeApi({ "flow.list": flows }).api, <Catalog onOpen={onOpen} onRecord={onRecord} />);
  return { onOpen, onRecord };
}

test("lists each flow with its status, revision, and update time", async () => {
  renderCatalog(async () => ({ flows: FLOWS }));
  const rows = page.getByRole("row");
  await expectTexts(rows.nth(1), "Log in", "recorded", "aaaaaaaaaaaa", NOW);
  await expectTexts(rows.nth(2), "Place an order", "validated");
});

test("opens a flow and starts a new recording", async () => {
  const { onOpen, onRecord } = renderCatalog(async () => ({ flows: FLOWS }));
  await page.getByRole("button", { name: "Open Place an order" }).click();
  expect(onOpen).toHaveBeenCalledWith("order");
  await page.getByRole("button", { name: "New recording" }).click();
  expect(onRecord).toHaveBeenCalledOnce();
});

test("shows an empty state", async () => {
  renderCatalog(async () => ({ flows: [] }));
  await expect.element(page.getByText("No flows yet. Record one to start.")).toBeVisible();
});

test("shows the service's error and retries", async () => {
  let fail = true;
  renderCatalog(async () => {
    if (fail) throw new ApiError("internal", "The index is locked.");
    return { flows: FLOWS };
  });
  await expectTexts(page.getByRole("alert"), "The index is locked.", "internal");
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.element(page.getByText("Log in")).toBeVisible();
});
