import { startDashboard } from "@/dashboard/start";
import "@/dashboard/dashboard.css";

const root = document.getElementById("app");
if (root) startDashboard(root);
