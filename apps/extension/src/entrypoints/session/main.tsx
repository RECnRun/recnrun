import { startSession } from "@/session/start";
import { sessionTab } from "@/session/session-tab";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import "@recnrun/brand/base.css";
import "@recnrun/brand/mona-sans.css";
import "@/views/views.css";

const root = document.getElementById("app");
if (root) startSession(root, { recordings: recordingSessionRepository, tab: sessionTab() });
