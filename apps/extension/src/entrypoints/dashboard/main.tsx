import { render } from "preact";
import { Dashboard } from "@/dashboard/Dashboard";
import { readSnapshot } from "@/storage/snapshot-repository";
import "@/dashboard/dashboard.css";

const root = document.getElementById("app");
if (root) render(<Dashboard loadSnapshot={readSnapshot} />, root);
