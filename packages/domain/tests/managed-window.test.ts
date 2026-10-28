import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  classifyIncognitoWindows,
  isAllowedTarget,
  ManagedWindowStateSchema,
} from "../src/index.ts";
import type { ManagedWindowState } from "../src/index.ts";

const active: ManagedWindowState = { generation: 2, windowId: 7, tabId: 70, status: "active" };

describe("ManagedWindowStateSchema", () => {
  test("accepts an active or closed window with its tab and generation", () => {
    expect(v.is(ManagedWindowStateSchema, active)).toBe(true);
    expect(v.is(ManagedWindowStateSchema, { ...active, status: "closed", generation: 0 })).toBe(
      true,
    );
  });

  test("rejects an unknown status, negative or fractional numbers, and missing fields", () => {
    expect(v.is(ManagedWindowStateSchema, { ...active, status: "open" })).toBe(false);
    expect(v.is(ManagedWindowStateSchema, { ...active, generation: -1 })).toBe(false);
    expect(v.is(ManagedWindowStateSchema, { ...active, generation: 1.5 })).toBe(false);
    expect(v.is(ManagedWindowStateSchema, { ...active, windowId: -1 })).toBe(false);
    expect(v.is(ManagedWindowStateSchema, { ...active, tabId: 0.5 })).toBe(false);
    const { tabId: _, ...untabbed } = active;
    expect(v.is(ManagedWindowStateSchema, untabbed)).toBe(false);
  });
});

describe("classifyIncognitoWindows", () => {
  const normal = { id: 1, incognito: false, type: "normal" };
  const managedWindow = { id: 7, incognito: true, type: "normal" };
  const foreignWindow = { id: 8, incognito: true, type: "normal" };
  const foreignPopup = { id: 9, incognito: true, type: "popup" };

  test("splits Incognito windows into the managed one and the foreign ones", () => {
    const windows = [normal, managedWindow, foreignWindow, foreignPopup];
    expect(classifyIncognitoWindows(windows, active)).toEqual({
      managed: managedWindow,
      foreign: [foreignWindow, foreignPopup],
    });
  });

  test("counts every Incognito window as foreign without an active managed window", () => {
    const windows = [managedWindow, foreignWindow];
    const none = { managed: undefined, foreign: windows };
    expect(classifyIncognitoWindows(windows, undefined)).toEqual(none);
    expect(classifyIncognitoWindows(windows, { ...active, status: "closed" })).toEqual(none);
  });

  test("leaves out normal and DevTools windows", () => {
    const windows = [normal, { id: 2, incognito: true, type: "devtools" }];
    expect(classifyIncognitoWindows(windows, active)).toEqual({ managed: undefined, foreign: [] });
  });

  test("counts an Incognito always-on-top window, such as a Document PiP, as foreign", () => {
    const pip = { id: 3, incognito: true, type: "normal", alwaysOnTop: true };
    expect(classifyIncognitoWindows([pip], active)).toEqual({ managed: undefined, foreign: [pip] });
  });

  test("keeps an Incognito window of an unreported type, since it would still block a reset", () => {
    const untyped = { id: 4, incognito: true };
    expect(classifyIncognitoWindows([untyped], undefined)).toEqual({
      managed: undefined,
      foreign: [untyped],
    });
  });
});

describe("isAllowedTarget", () => {
  test("accepts http and https pages", () => {
    for (const url of [
      "https://app.example/",
      "http://app.localhost:5192/sentinel?tag=a",
      "HTTPS://Example.com/path#hash",
    ]) {
      expect(isAllowedTarget(url), url).toBe(true);
    }
  });

  test("rejects browser-internal, local, inline, and unparsable targets", () => {
    for (const url of [
      "chrome://settings/",
      "chrome-extension://abc/dashboard.html",
      "about:blank",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://app.example/",
      "data:text/html,<p>hi</p>",
      "file:///etc/hosts",
      "blob:https://app.example/1234",
      "javascript:alert(1)",
      "ftp://files.example/",
      "https://",
      "app.example",
      " https://app.example/",
      "",
    ]) {
      expect(isAllowedTarget(url), url).toBe(false);
    }
  });
});
