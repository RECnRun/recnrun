// The provision every gate reads: the launcher's policy.json, else the lab harness's storage entry.
import { readPackaged } from "./packaged.js";
import { createProvision } from "./policy.js";

const readStorage = async () => (await chrome.storage.local.get("provision")).provision;

export const provision = createProvision({
  readPolicy: () => readPackaged("policy.json"),
  readStorage,
});
