import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  IdentityCaptureSchema,
  IdentityDataSchema,
  primaryTab,
  restorableData,
  SessionLayoutSchema,
} from "../src/index.ts";
import type { SessionLayout } from "../src/index.ts";
import { sampleCapture } from "./fixtures.ts";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";

/** Two windows: the target and a second tab of its origin, then a tab of another origin. */
const layout: SessionLayout = {
  windows: [
    {
      focused: false,
      tabs: [
        { url: `${APP}/app/`, active: true, sessionStorage: [] },
        {
          url: `${APP}/app/?tab=2`,
          active: false,
          sessionStorage: [{ origin: APP, entries: { tab: "2" } }],
        },
      ],
    },
    {
      focused: true,
      tabs: [{ url: `${OTHER}/`, active: true, sessionStorage: [{ origin: OTHER, entries: {} }] }],
    },
  ],
  primary: { window: 0, tab: 0 },
};

const valid = (value: unknown) => v.is(SessionLayoutSchema, value);
const [first, second] = layout.windows;

test("accepts windows in order, each tab's page, activity, and own sessionStorage", () => {
  expect(v.parse(SessionLayoutSchema, layout)).toEqual(layout);
  expect(primaryTab(layout)).toBe(first?.tabs[0]);
});

test("rejects a missing primary tab, an empty window, two focused windows, or two active tabs", () => {
  expect(valid({ ...layout, primary: { window: 1, tab: 1 } })).toBe(false);
  expect(valid({ ...layout, primary: { window: 2, tab: 0 } })).toBe(false);
  expect(valid({ ...layout, windows: [] })).toBe(false);
  expect(valid({ ...layout, windows: [first, { focused: false, tabs: [] }] })).toBe(false);
  expect(valid({ ...layout, windows: [{ ...first, focused: true }, second] })).toBe(false);
  const tabs = first?.tabs.map((tab) => ({ ...tab, active: true }));
  expect(valid({ ...layout, windows: [{ ...first, tabs }, second] })).toBe(false);
  expect(() => primaryTab({ ...layout, primary: { window: 3, tab: 0 } })).toThrow(/no primary/);
});

test("accepts a blank tab and a New Tab page beside the target, without sessionStorage", () => {
  const plain = (url: string, sessionStorage: unknown[] = []) => ({
    ...layout,
    windows: [{ ...first, tabs: [...(first?.tabs ?? []), { url, active: false, sessionStorage }] }],
  });
  expect(valid(plain("about:blank"))).toBe(true);
  expect(valid(plain("chrome://newtab/"))).toBe(true);
  expect(valid(plain("about:blank", [{ origin: APP, entries: {} }]))).toBe(false);
  // The primary tab is the start's target, so it is always a web page.
  const blankFirst = { url: "about:blank", active: true, sessionStorage: [] };
  expect(valid({ ...layout, windows: [{ ...first, tabs: [blankFirst] }, second] })).toBe(false);
});

test("rejects any other internal page and an origin named twice in one tab", () => {
  const tab = (fields: object) => ({ ...layout, windows: [{ ...first, tabs: [fields] }] });
  for (const url of ["chrome://settings/", "about:srcdoc", "file:///tmp/x.html"]) {
    expect(valid(tab({ url, active: true, sessionStorage: [] }))).toBe(false);
  }
  const twice = [
    { origin: APP, entries: {} },
    { origin: APP, entries: { b: "2" } },
  ];
  expect(valid(tab({ url: `${APP}/`, active: true, sessionStorage: twice }))).toBe(false);
});

test("a capture's layout names its target as the primary tab, and a start restores it", () => {
  const capture = { ...sampleCapture(), layout };
  expect(v.is(IdentityCaptureSchema, capture)).toBe(true);
  const elsewhere = { ...layout, primary: { window: 1, tab: 0 } };
  expect(v.is(IdentityCaptureSchema, { ...capture, layout: elsewhere })).toBe(false);
  const data = restorableData(capture);
  expect(data.layout).toEqual(layout);
  expect(v.is(IdentityDataSchema, data)).toBe(true);
  expect(restorableData(sampleCapture())).not.toHaveProperty("layout");
});
