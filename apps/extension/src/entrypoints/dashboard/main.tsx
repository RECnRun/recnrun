import { browser } from "wxt/browser";
import { startDashboard } from "@/dashboard/start";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { readSnapshot } from "@/storage/snapshot-repository";
import { browserIncognito, browserTabs } from "@/tabs/open-tabs";
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
    send: (request) => void browser.runtime.sendMessage(request),
  });
}
