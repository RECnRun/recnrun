import { describe, expect, test } from "vite-plus/test";
import { pageRunEvents } from "../src/index.ts";
import { finished, journal, response, started } from "./run-builders.ts";

const events = journal("run-1", [
  started("open"),
  response("http://127.0.0.1:4600/api/save", 200),
  response("http://127.0.0.1:4601/logo.png", 200, "home"),
  finished("open", "passed"),
]);
const ids = (page: ReturnType<typeof pageRunEvents>) => page?.events.map(({ id }) => id);
const all = { start: 0, limit: 100 };

describe("pageRunEvents", () => {
  test("stops a page at the limit and resumes from the next matching position", () => {
    const first = pageRunEvents(events, { category: "network" }, { start: 0, limit: 1 });
    expect(first).toEqual({ events: [events[1]], next: 2 });
    expect(pageRunEvents(events, { category: "network" }, { start: 2, limit: 1 })).toEqual({
      events: [events[2]],
    });
  });

  test("refuses a start past the end and answers an empty page at the end", () => {
    expect(pageRunEvents(events, {}, { start: 5, limit: 1 })).toBeUndefined();
    expect(pageRunEvents(events, {}, { start: 4, limit: 1 })).toEqual({ events: [] });
  });

  test("combines type, origin, profile, and time filters", () => {
    expect(ids(pageRunEvents(events, { types: ["step.finished", "response"] }, all))).toEqual([
      "cdp:network#1",
      "cdp:network#2",
      "engine:replay#2",
    ]);
    const origin = { origin: "http://127.0.0.1:4601/any/path" };
    expect(ids(pageRunEvents(events, origin, all))).toEqual(["cdp:network#2"]);
    expect(ids(pageRunEvents(events, { origin: "not a url" }, all))).toEqual([]);
    expect(ids(pageRunEvents(events, { profile: "home" }, all))).toEqual(["cdp:network#2"]);
    const range = { from: events[1]?.timestamp, to: events[3]?.timestamp, stepId: undefined };
    expect(ids(pageRunEvents(events, range, all))).toEqual(["cdp:network#1", "cdp:network#2"]);
  });
});
