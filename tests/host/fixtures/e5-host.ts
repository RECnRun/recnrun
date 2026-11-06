import type { E5Environment } from "../../experiments/fixtures/e5-run.ts";
import { host } from "./downloads.ts";
import { hostFolder, launch, removeFolder } from "./e4-host.ts";

/*
 * E5 on the installed Google Chrome of this Mac: every profile is a throwaway root of this run,
 * and the Downloads folder they share is a stand-in root written into each root's Preferences
 * before its first launch, so nothing reaches ~/Downloads.
 */

export const hostE5: E5Environment = {
  target: host.target,
  platform: () => {
    let standIn: string | undefined;
    return {
      makeFolder: (name) => hostFolder(`e5-${name}`),
      removeFolder,
      launch,
      shared: async () => {
        standIn = await hostFolder("e5-downloads");
        return { downloads: standIn, written: true };
      },
      cleanup: async () => {
        if (standIn) await removeFolder(standIn);
      },
    };
  },
};
