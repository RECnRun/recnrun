import { startDashboard } from "@/dashboard/start";
import { readSnapshot } from "@/storage/snapshot-repository";
import "@recnrun/brand/mona-sans.css";
import "@/dashboard/dashboard.css";

const root = document.getElementById("app");
if (root) startDashboard(root, readSnapshot);
