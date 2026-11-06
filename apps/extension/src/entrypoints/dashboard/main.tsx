import { browser } from "wxt/browser";
import { browserIncognito } from "@/dashboard/incognito-access";
import { startDashboard } from "@/dashboard/start";
import { browserToolbarPin } from "@/dashboard/toolbar-pin";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { readSnapshot } from "@/storage/snapshot-repository";
import { browserTabs } from "@/tabs/open-tabs";
import { peerServices } from "@/peers/page-services";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";
import "@/dashboard/dashboard.css";

// Spelled out like peersEnabled(), not called, so the production build can drop the cross-profile mesh.
const PEERS =
  import.meta.env.MODE === "development" ||
  import.meta.env.MODE === "test" ||
  import.meta.env.MODE === "poc-d0" ||
  import.meta.env.MODE === "poc-d1" ||
  import.meta.env.MODE === "poc-d2";

// Spelled out, so the production build drops the dynamic import and its stylesheet with the branch.
const POC =
  import.meta.env.MODE === "poc-d0" ||
  import.meta.env.MODE === "poc-d1" ||
  import.meta.env.MODE === "poc-d2";
if (POC) {
  void import("@/onboarding/mount").then(({ mountPrepareWorkers }) => mountPrepareWorkers());
  void import("@/onboarding/clone-control-mount").then(({ mountCloneControl }) =>
    mountCloneControl(),
  );
}

const root = document.getElementById("app");
if (root) {
  startDashboard(root, {
    loadSnapshot: readSnapshot,
    recordings: recordingSessionRepository,
    tabs: browserTabs(),
    incognito: browserIncognito,
    toolbar: browserToolbarPin,
    send: (request) => browser.runtime.sendMessage(request),
    peers: PEERS ? peerServices() : undefined,
  });
}
