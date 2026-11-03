import { browser } from "wxt/browser";

const permissions = browser.runtime.getManifest().permissions ?? [];

const report = {
  extensionId: browser.runtime.id,
  mode: import.meta.env.MODE,
  permissions,
  fileSchemeAccess: await browser.extension.isAllowedFileSchemeAccess(),
  incognitoAccess: await browser.extension.isAllowedIncognitoAccess(),
  debuggerDeclared: permissions.includes("debugger"),
};

const target = document.getElementById("diagnostics");
if (target) target.textContent = JSON.stringify(report, null, 2);
