import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browserHistory, HISTORY_RESULTS } from "@/dashboard/browser-history";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("searches all of the normal profile's history for the typed text, a page of results at most", async () => {
  const search = vi
    .spyOn(fakeBrowser.history, "search")
    .mockResolvedValue([
      { id: "1", url: "https://app.example/", title: "App", lastVisitTime: 7 },
      { id: "2", url: "https://untitled.example/", title: "" },
      { id: "3" },
    ] as never);
  expect(await browserHistory.search("app")).toEqual([
    { url: "https://app.example/", title: "App", lastVisitTime: 7 },
    { url: "https://untitled.example/", title: "https://untitled.example/" },
  ]);
  // Without startTime Chrome searches only the last 24 hours.
  expect(search).toHaveBeenCalledWith({ text: "app", startTime: 0, maxResults: HISTORY_RESULTS });
});
