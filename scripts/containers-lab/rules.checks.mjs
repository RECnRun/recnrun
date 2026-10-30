// Unit checks for the rules module's webRequest observers: they cover every host the extension
// may reach, so a real site's Set-Cookie headers land in the jar as the lab's do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRules } from "./extension/rules.js";

const filters = {};
const listener = (name) => ({ addListener: (fn, filter) => (filters[name] = filter) });
globalThis.chrome = {
  webRequest: {
    onHeadersReceived: listener("onHeadersReceived"),
    onSendHeaders: listener("onSendHeaders"),
  },
  tabs: { onRemoved: listener("onRemoved") },
};

await test("the Set-Cookie observer and the navigation observer cover every permitted host", () => {
  startRules();
  assert.deepEqual(filters.onHeadersReceived, { urls: ["<all_urls>"] });
  assert.deepEqual(filters.onSendHeaders, { urls: ["<all_urls>"], types: ["main_frame"] });
});
