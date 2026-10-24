import { startSession } from "@/session/start";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { browserTabs } from "@/tabs/open-tabs";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";

const root = document.getElementById("app");
if (root) startSession(root, { recordings: recordingSessionRepository, tabs: browserTabs() });
