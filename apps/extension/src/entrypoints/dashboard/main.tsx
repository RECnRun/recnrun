import { dashboardTab } from "@/dashboard/dashboard-tab";
import { startDashboard } from "@/dashboard/start";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { readSnapshot } from "@/storage/snapshot-repository";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/dashboard/dashboard.css";

const root = document.getElementById("app");
if (root) {
  startDashboard(root, {
    loadSnapshot: readSnapshot,
    recordings: recordingSessionRepository,
    tab: dashboardTab(),
  });
}
