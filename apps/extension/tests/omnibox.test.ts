import { sampleSnapshot } from "@recnrun/domain/testing";
import { expect, test } from "vite-plus/test";
import {
  createOmniboxHandlers,
  escapeXml,
  routeForInput,
  suggestRecordings,
} from "@/background/omnibox";
import { parseRoute } from "@/dashboard/route";

test("escapes every XML special character", () => {
  expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
    "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;",
  );
});

test("maps entered text to a dashboard route that the dashboard parses back", () => {
  expect(routeForInput("  ")).toBe("");
  expect(parseRoute(`#${routeForInput("rec:a/b #1")}`)).toEqual({
    view: "recording",
    id: "a/b #1",
  });
  expect(parseRoute(`#${routeForInput(" 50% off ")}`)).toEqual({
    view: "search",
    query: "50% off",
  });
  expect(parseRoute("#/search/%E0%A4%A")).toEqual({ view: "all" });
});

test("caps suggestions at five, newest first", () => {
  const [recording] = sampleSnapshot().recordings;
  if (!recording) throw new Error("The sample has recordings.");
  const many = Array.from({ length: 7 }, (_, index) => ({
    ...recording,
    id: `rec-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  const { suggestions } = suggestRecordings(many, "admin");
  expect(suggestions.map((suggestion) => suggestion.content)).toEqual([
    "rec:rec-6",
    "rec:rec-5",
    "rec:rec-4",
    "rec:rec-3",
    "rec:rec-2",
  ]);
});

test("suggests nothing but keeps the default when stored data is invalid", async () => {
  const handlers = createOmniboxHandlers(() => Promise.reject(new Error("bad schema")));
  await expect(handlers.inputChanged("x")).resolves.toEqual({
    defaultDescription: "Search RECnRun recordings for <match>x</match>",
    suggestions: [],
  });
});
