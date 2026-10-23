import { describe, expect, test, vi } from "vite-plus/test";
import { createOpenDashboardListener, matchesOrigins } from "@/background/open-dashboard";

const isAllowedPage = matchesOrigins(["https://recnrun.com/*", "http://localhost/*"]);

function listen(message: unknown, sender: { id?: string; url?: string; tab?: { id?: number } }) {
  const openInTab = vi.fn(async () => undefined);
  createOpenDashboardListener({ extensionId: "own-id", isAllowedPage, openInTab })(message, sender);
  return openInTab;
}

const fromSite = { id: "own-id", url: "https://recnrun.com/", tab: { id: 7 } };

describe("createOpenDashboardListener", () => {
  test("moves the sending recnrun.com tab to the dashboard", () => {
    expect(listen({ type: "openDashboard" }, fromSite)).toHaveBeenCalledWith(7);
  });

  test.each([
    ["another message", { type: "ping" }, fromSite],
    ["another extension", { type: "openDashboard" }, { ...fromSite, id: "other-id" }],
    [
      "a page outside the site",
      { type: "openDashboard" },
      { ...fromSite, url: "https://evil.example/" },
    ],
    [
      "http on the production host",
      { type: "openDashboard" },
      { ...fromSite, url: "http://recnrun.com/" },
    ],
    [
      "a sender without a tab",
      { type: "openDashboard" },
      { id: "own-id", url: "https://recnrun.com/" },
    ],
  ])("ignores %s", (_name, message, sender) => {
    expect(listen(message, sender)).not.toHaveBeenCalled();
  });

  test("accepts any localhost port in development builds", () => {
    expect(isAllowedPage("http://localhost:5190/?redirect=tabs")).toBe(true);
  });
});
