import { browser } from "wxt/browser";
import { browserIncognito } from "@/dashboard/incognito-access";
import { startDashboard } from "@/dashboard/start";
import { browserToolbarPin } from "@/dashboard/toolbar-pin";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { readSnapshot } from "@/storage/snapshot-repository";
import { browserTabs } from "@/tabs/open-tabs";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";
import "@/dashboard/dashboard.css";

const root = document.getElementById("app");
if (root) {
  startDashboard(root, {
    loadSnapshot: readSnapshot,
    recordings: recordingSessionRepository,
    tabs: browserTabs(),
    incognito: browserIncognito,
    toolbar: browserToolbarPin,
    send: (request) => browser.runtime.sendMessage(request),
  });
}
