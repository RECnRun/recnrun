import { defineContentScript } from "wxt/utils/define-content-script";
import { contentScriptMatches } from "@/config/origins";
import { startContentBridge } from "@/content/start";

export default defineContentScript({
  matches: contentScriptMatches(import.meta.env.MODE),
  main: startContentBridge,
});
