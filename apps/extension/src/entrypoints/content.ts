import { defineContentScript } from "wxt/utils/define-content-script";
import { contentScriptExcludes, contentScriptMatches } from "@/config/origins";
import { startContentBridge } from "@/content/start";

export default defineContentScript({
  matches: contentScriptMatches(import.meta.env.MODE),
  excludeMatches: contentScriptExcludes(import.meta.env.MODE),
  main: startContentBridge,
});
