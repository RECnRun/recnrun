import { defineContentScript } from "wxt/utils/define-content-script";
import { startOriginAgent } from "@/origin/agent";

// Registered at run time by the barrier, for one origin, only while an operation restores it.
export default defineContentScript({
  registration: "runtime",
  main: startOriginAgent,
});
